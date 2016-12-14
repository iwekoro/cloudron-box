'use strict';

exports = module.exports = {
    installAdminCertificate: installAdminCertificate,
    renewAll: renewAll,
    setFallbackCertificate: setFallbackCertificate,
    setAdminCertificate: setAdminCertificate,
    CertificatesError: CertificatesError,
    validateCertificate: validateCertificate,
    ensureCertificate: ensureCertificate,
    getAdminCertificatePath: getAdminCertificatePath,

    // exported for testing
    _getApi: getApi
};

var acme = require('./cert/acme.js'),
    apps = require('./apps.js'),
    assert = require('assert'),
    async = require('async'),
    caas = require('./cert/caas.js'),
    config = require('./config.js'),
    constants = require('./constants.js'),
    debug = require('debug')('box:src/certificates'),
    eventlog = require('./eventlog.js'),
    fallback = require('./cert/fallback.js'),
    fs = require('fs'),
    mailer = require('./mailer.js'),
    nginx = require('./nginx.js'),
    path = require('path'),
    paths = require('./paths.js'),
    safe = require('safetydance'),
    settings = require('./settings.js'),
    subdomains = require('./subdomains.js'),
    sysinfo = require('./sysinfo.js'),
    user = require('./user.js'),
    util = require('util'),
    x509 = require('x509');

function CertificatesError(reason, errorOrMessage) {
    assert.strictEqual(typeof reason, 'string');
    assert(errorOrMessage instanceof Error || typeof errorOrMessage === 'string' || typeof errorOrMessage === 'undefined');

    Error.call(this);
    Error.captureStackTrace(this, this.constructor);

    this.name = this.constructor.name;
    this.reason = reason;
    if (typeof errorOrMessage === 'undefined') {
        this.message = reason;
    } else if (typeof errorOrMessage === 'string') {
        this.message = errorOrMessage;
    } else {
        this.message = 'Internal error';
        this.nestedError = errorOrMessage;
    }
}
util.inherits(CertificatesError, Error);
CertificatesError.INTERNAL_ERROR = 'Internal Error';
CertificatesError.INVALID_CERT = 'Invalid certificate';
CertificatesError.NOT_FOUND = 'Not Found';

function getApi(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    settings.getTlsConfig(function (error, tlsConfig) {
        if (error) return callback(error);

        if (tlsConfig.provider === 'fallback') return callback(null, fallback, {});

        // use acme if we have altDomain or the tlsConfig is not caas
        var api = (app.altDomain || tlsConfig.provider) !== 'caas' ? acme : caas;

        var options = { };
        if (tlsConfig.provider === 'caas') {
            options.prod = !config.isDev(); // with altDomain, we will choose acme setting based on this
        } else { // acme
            options.prod = tlsConfig.provider.match(/.*-prod/) !== null;
        }

        // registering user with an email requires A or MX record (https://github.com/letsencrypt/boulder/issues/1197)
        // we cannot use admin@fqdn because the user might not have set it up.
        // we simply update the account with the latest email we have each time when getting letsencrypt certs
        // https://github.com/ietf-wg-acme/acme/issues/30
        user.getOwner(function (error, owner) {
            options.email = error ? 'support@cloudron.io' : owner.email; // can error if not activated yet

            callback(null, api, options);
        });
    });
}

function installAdminCertificate(callback) {
    if (process.env.BOX_ENV === 'test') return callback();

    sysinfo.getIp(function (error, ip) {
        if (error) return callback(error);

        subdomains.waitForDns(config.adminFqdn(), ip, 'A', { interval: 30000, times: 50000 }, function (error) {
            if (error) return callback(error);

            ensureCertificate({ location: constants.ADMIN_LOCATION }, function (error, certFilePath, keyFilePath) {
                if (error) { // currently, this can never happen
                    debug('Error obtaining certificate. Proceed anyway', error);
                    return callback();
                }

                nginx.configureAdmin(certFilePath, keyFilePath, callback);
            });
        });
    });
}

function isExpiringSync(certFilePath, hours) {
    assert.strictEqual(typeof certFilePath, 'string');
    assert.strictEqual(typeof hours, 'number');

    if (!fs.existsSync(certFilePath)) return 2; // not found

    var result = safe.child_process.spawnSync('/usr/bin/openssl', [ 'x509', '-checkend', String(60 * 60 * hours), '-in', certFilePath ]);

    debug('isExpiringSync: %s %s %s', certFilePath, result.stdout.toString('utf8').trim(), result.status);

    return result.status === 1; // 1 - expired 0 - not expired
}

function renewAll(auditSource, callback) {
    assert.strictEqual(typeof auditSource, 'object');
    assert.strictEqual(typeof callback, 'function');

    debug('renewAll: Checking certificates for renewal');

    apps.getAll(function (error, allApps) {
        if (error) return callback(error);

        allApps.push({ location: constants.ADMIN_LOCATION }); // inject fake webadmin app

        var expiringApps = [ ];
        for (var i = 0; i < allApps.length; i++) {
            var appDomain = allApps[i].altDomain || config.appFqdn(allApps[i].location);

            var certFilePath = path.join(paths.APP_CERTS_DIR, appDomain + '.user.cert');
            var keyFilePath = path.join(paths.APP_CERTS_DIR, appDomain + '.user.key');

            if (safe.fs.existsSync(certFilePath) && safe.fs.existsSync(keyFilePath)) {
                debug('renewAll: existing user key file for %s. skipping', appDomain);
                continue;
            }

            // check if we have an auto cert to be renewed
            certFilePath = path.join(paths.APP_CERTS_DIR, appDomain + '.cert');
            keyFilePath = path.join(paths.APP_CERTS_DIR, appDomain + '.key');

            if (!safe.fs.existsSync(keyFilePath)) {
                debug('renewAll: no existing key file for %s. skipping', appDomain);
                continue;
            }

            if (isExpiringSync(certFilePath, 24 * 30)) { // expired or not found
                expiringApps.push(allApps[i]);
            }
        }

        debug('renewAll: %j needs to be renewed', expiringApps.map(function (a) { return a.altDomain || config.appFqdn(a.location); }));

        async.eachSeries(expiringApps, function iterator(app, iteratorCallback) {
            var domain = app.altDomain || config.appFqdn(app.location);

            getApi(app, function (error, api, apiOptions) {
                if (error) return callback(error);

                debug('renewAll: renewing cert for %s with options %j', domain, apiOptions);

                api.getCertificate(domain, apiOptions, function (error) {
                    var certFilePath = path.join(paths.APP_CERTS_DIR, domain + '.cert');
                    var keyFilePath = path.join(paths.APP_CERTS_DIR, domain + '.key');

                    var errorMessage = error ? error.message : '';
                    eventlog.add(eventlog.ACTION_CERTIFICATE_RENEWAL, auditSource, { domain: domain, errorMessage: errorMessage });

                    if (error) {
                        debug('renewAll: could not renew cert for %s because %s', domain, error);

                        mailer.certificateRenewalError(domain, errorMessage);

                        // check if we should fallback if we expire in the coming day
                        if (!isExpiringSync(certFilePath, 24 * 1)) return iteratorCallback();

                        debug('renewAll: using fallback certs for %s since it expires soon', domain, error);

                        certFilePath = 'cert/host.cert';
                        keyFilePath = 'cert/host.key';
                    } else {
                        debug('renewAll: certificate for %s renewed', domain);
                    }

                    // reconfigure and reload nginx. this is required for the case where we got a renewed cert after fallback
                    var configureFunc = app.location === constants.ADMIN_LOCATION ?
                        nginx.configureAdmin.bind(null, certFilePath, keyFilePath)
                        : nginx.configureApp.bind(null, app, certFilePath, keyFilePath);

                    configureFunc(function (ignoredError) {
                        if (ignoredError) debug('fallbackExpiredCertificates: error reconfiguring app', ignoredError);

                        iteratorCallback(); // move to next app
                    });
                });
            });
        });
    });
}

// note: https://tools.ietf.org/html/rfc4346#section-7.4.2 (certificate_list) requires that the
// servers certificate appears first (and not the intermediate cert)
function validateCertificate(cert, key, fqdn) {
    assert(cert === null || typeof cert === 'string');
    assert(key === null || typeof key === 'string');
    assert.strictEqual(typeof fqdn, 'string');

    if (cert === null && key === null) return null;
    if (!cert && key) return new Error('missing cert');
    if (cert && !key) return new Error('missing key');

    var content;
    try {
        content = x509.parseCert(cert);
    } catch (e) {
        return new Error('invalid cert: ' + e.message);
    }

    // check expiration
    if (content.notAfter < new Date()) return new Error('cert expired');

    function matchesDomain(domain) {
        if (domain === fqdn) return true;
        if (domain.indexOf('*') === 0 && domain.slice(2) === fqdn.slice(fqdn.indexOf('.') + 1)) return true;

        return false;
    }

    // check domain
    var domains = content.altNames.concat(content.subject.commonName);
    if (!domains.some(matchesDomain)) return new Error(util.format('cert is not valid for this domain. Expecting %s in %j', fqdn, domains));

    // http://httpd.apache.org/docs/2.0/ssl/ssl_faq.html#verify
    var certModulus = safe.child_process.execSync('openssl x509 -noout -modulus', { encoding: 'utf8', input: cert });
    var keyModulus = safe.child_process.execSync('openssl rsa -noout -modulus', { encoding: 'utf8', input: key });
    if (certModulus !== keyModulus) return new Error('key does not match the cert');

    return null;
}

function setFallbackCertificate(cert, key, callback) {
    assert.strictEqual(typeof cert, 'string');
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(typeof callback, 'function');

    var error = validateCertificate(cert, key, '*.' + config.fqdn());
    if (error) return callback(new CertificatesError(CertificatesError.INVALID_CERT, error.message));

    // backup the cert
    if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, 'host.cert'), cert)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));
    if (!safe.fs.writeFileSync(path.join(paths.APP_CERTS_DIR, 'host.key'), key)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));

    // copy over fallback cert
    if (!safe.fs.writeFileSync(path.join(paths.NGINX_CERT_DIR, 'host.cert'), cert)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));
    if (!safe.fs.writeFileSync(path.join(paths.NGINX_CERT_DIR, 'host.key'), key)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));

    nginx.reload(function (error) {
        if (error) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, error));

        return callback(null);
    });
}

function getFallbackCertificatePath(callback) {
    assert.strictEqual(typeof callback, 'function');

    // any user fallback cert is always copied over to nginx cert dir
    callback(null, path.join(paths.NGINX_CERT_DIR, 'host.cert'), path.join(paths.NGINX_CERT_DIR, 'host.key'));
}

// FIXME: setting admin cert needs to restart the mail container because it uses admin cert
function setAdminCertificate(cert, key, callback) {
    assert.strictEqual(typeof cert, 'string');
    assert.strictEqual(typeof key, 'string');
    assert.strictEqual(typeof callback, 'function');

    var vhost = config.adminFqdn();
    var certFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.cert');
    var keyFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.key');

    var error = validateCertificate(cert, key, vhost);
    if (error) return callback(new CertificatesError(CertificatesError.INVALID_CERT, error.message));

    // backup the cert
    if (!safe.fs.writeFileSync(certFilePath, cert)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));
    if (!safe.fs.writeFileSync(keyFilePath, key)) return callback(new CertificatesError(CertificatesError.INTERNAL_ERROR, safe.error.message));

    nginx.configureAdmin(certFilePath, keyFilePath, callback);
}

function getAdminCertificatePath(callback) {
    assert.strictEqual(typeof callback, 'function');

    var vhost = config.adminFqdn();
    var certFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.cert');
    var keyFilePath = path.join(paths.APP_CERTS_DIR, vhost + '.key');

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) return callback(null, certFilePath, keyFilePath);

    getFallbackCertificatePath(callback);
}

function ensureCertificate(app, callback) {
    assert.strictEqual(typeof app, 'object');
    assert.strictEqual(typeof callback, 'function');

    var domain = app.altDomain || config.appFqdn(app.location);

    var certFilePath = path.join(paths.APP_CERTS_DIR, domain + '.user.cert');
    var keyFilePath = path.join(paths.APP_CERTS_DIR, domain + '.user.key');

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) {
        debug('ensureCertificate: %s. user certificate already exists at %s', domain, keyFilePath);
        return callback(null, certFilePath, keyFilePath);
    }

    certFilePath = path.join(paths.APP_CERTS_DIR, domain + '.cert');
    keyFilePath = path.join(paths.APP_CERTS_DIR, domain + '.key');

    if (fs.existsSync(certFilePath) && fs.existsSync(keyFilePath)) {
        debug('ensureCertificate: %s. certificate already exists at %s', domain, keyFilePath);

        if (!isExpiringSync(certFilePath, 24 * 1)) return callback(null, certFilePath, keyFilePath);
    }

    debug('ensureCertificate: %s cert require renewal', domain);

    getApi(app, function (error, api, apiOptions) {
        if (error) return callback(error);

        debug('ensureCertificate: getting certificate for %s with options %j', domain, apiOptions);

        api.getCertificate(domain, apiOptions, function (error, certFilePath, keyFilePath) {
            if (error) {
                debug('ensureCertificate: could not get certificate. using fallback certs', error);
                return callback(null, 'cert/host.cert', 'cert/host.key'); // use fallback certs
            }

            callback(null, certFilePath, keyFilePath);
        });
    });
}
