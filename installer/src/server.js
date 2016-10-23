#!/usr/bin/env node

/* jslint node: true */

'use strict';

var assert = require('assert'),
    async = require('async'),
    debug = require('debug')('installer:server'),
    dns = require('dns'),
    express = require('express'),
    fs = require('fs'),
    http = require('http'),
    HttpError = require('connect-lastmile').HttpError,
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    installer = require('./installer.js'),
    json = require('body-parser').json,
    lastMile = require('connect-lastmile'),
    morgan = require('morgan'),
    path = require('path'),
    safe = require('safetydance');

exports = module.exports = {
    start: start,
    stop: stop
};

var PROVISION_CONFIG_FILE_JSON = '/root/userdata.json';
var PROVISION_CONFIG_FILE_JS = '/root/userdata.js';
var CLOUDRON_CONFIG_FILE = '/home/yellowtent/configs/cloudron.conf';
var BOX_VERSIONS_URL = 'https://s3.amazonaws.com/prod-cloudron-releases/versions.json';

var gHttpServer = null; // update server; used for updates
var gSetupServer = null; // setup server; only used for initial setup

function provision(callback) {
    if (fs.existsSync(CLOUDRON_CONFIG_FILE)) {
        debug('provision: already provisioned');
        return callback(null); // already provisioned
    }

    var userData = null;

    function retry(error) {
        if (error) console.error(error);

        if (!gSetupServer) startSetupServer(function () { debug('Setup Server started.'); });

        setTimeout(provision.bind(null, callback), 5000);
    }

    // check for .json file then .js
    if (fs.existsSync(PROVISION_CONFIG_FILE_JSON)) {
        userData = safe.require(PROVISION_CONFIG_FILE_JSON);
        if (!userData) return retry('Provisioning data invalid');
    } else if (fs.existsSync(PROVISION_CONFIG_FILE_JS)) {
        var tmp = safe.require(PROVISION_CONFIG_FILE_JS);
        if (!tmp) return retry('Provisioning data invalid');

        // translate to expected format
        userData = { data: tmp };
    }

    if (!userData) return retry('No user data file found. Waiting for it...');

    // validate the bare minimum
    if (!userData.data || typeof userData.data !== 'object') return retry('user data misses "data" object');
    if (!userData.data.fqdn || typeof userData.data.fqdn !== 'string') return retry('fqdn in user data has to be a non-empty string');

    // set the fallback
    if (!userData.data.boxVersionsUrl) userData.data.boxVersionsUrl = BOX_VERSIONS_URL;

    if (typeof userData.data.boxVersionsUrl !== 'string') return retry('boxVersionsUrl in user data has to be a non-empty string');

    stopSetupServer(function () { debug('Setup Server stopped.'); });

    installer.provision(userData, callback);
}

function update(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.sourceTarballUrl || typeof req.body.sourceTarballUrl !== 'string') return next(new HttpError(400, 'No sourceTarballUrl provided'));
    if (!req.body.data || typeof req.body.data !== 'object') return next(new HttpError(400, 'No data provided'));

    debug('provision: received from box %j', req.body);

    installer.provision(req.body, function (error) {
        if (error) console.error(error);
    });

    next(new HttpSuccess(202, { }));
}

function startUpdateServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Starting update server');

    var app = express();

    var router = new express.Router();

    if (process.env.NODE_ENV !== 'test') app.use(morgan('dev', { immediate: false }));

    app.use(json({ strict: true }))
       .use(router)
       .use(lastMile());

    router.post('/api/v1/installer/update', update);

    gHttpServer = http.createServer(app);
    gHttpServer.on('error', console.error);

    gHttpServer.listen(2020, '127.0.0.1', callback);
}

function stopUpdateServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Stopping update server');

    if (!gHttpServer) return callback(null);

    gHttpServer.close(callback);
    gHttpServer = null;
}

function setup(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.fqdn || typeof req.body.fqdn !== 'string') return next(new HttpError(400, 'No fqdn provided'));

    debug('setup: %j', req.body);

    var data = {
        fqdn: req.body.fqdn
    };

    if (req.body.boxVersionsUrl && typeof req.body.boxVersionsUrl === 'string') data.boxVersionsUrl = req.body.boxVersionsUrl;

    fs.writeFile(PROVISION_CONFIG_FILE_JSON, JSON.stringify({ data: data }), function (error) {
        if (error) return next(new HttpError(500, error));

        next(new HttpSuccess(201, {}));
    });
}

function dnsReady(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.fqdn || typeof req.body.fqdn !== 'string') return next(new HttpError(400, 'No fqdn provided'));
    if (!req.body.ip || typeof req.body.ip !== 'string') return next(new HttpError(400, 'No ip provided'));

    debug('dnsReady: %j', req.body);

    dns.resolve4('my.' + req.body.fqdn, function (error, result) {
        if (error) return next(new HttpError(409, 'Not yet ready'));

        var sync = result.some(function (a) {
            return a === req.body.ip;
        });

        if (!sync) return next(new HttpError(409, 'Not yet ready'));

        next(new HttpError(200, {}));
    });
}

function startSetupServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Starting setup server');

    var app = express();

    var router = new express.Router();

    if (process.env.NODE_ENV !== 'test') app.use(morgan('dev', { immediate: false }));

    app.use(express.static(path.join(__dirname, '../www/')))
       .use(json({ strict: true }))
       .use(router)
       .use(lastMile());

    router.post('/api/v1/dns', dnsReady);
    router.post('/api/v1/setup', setup);

    gSetupServer = http.createServer(app);
    gSetupServer.on('error', console.error);

    gSetupServer.listen(process.env.SETUP_PORT || 80, '0.0.0.0', callback);
}

function stopSetupServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Stopping setup server');

    if (!gSetupServer) return callback(null);

    gSetupServer.close(callback);
    gSetupServer = null;
}

function start(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Starting Installer');

    var actions = [
        startUpdateServer,
        provision
    ];

    async.series(actions, callback);
}

function stop(callback) {
    assert.strictEqual(typeof callback, 'function');

    async.series([
        stopUpdateServer
    ], callback);
}

if (require.main === module) {
    start(function (error) {
        if (error) console.error(error);
    });
}
