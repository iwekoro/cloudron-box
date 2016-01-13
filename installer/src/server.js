#!/usr/bin/env node

/* jslint node: true */

'use strict';

var assert = require('assert'),
    async = require('async'),
    debug = require('debug')('installer:server'),
    express = require('express'),
    fs = require('fs'),
    http = require('http'),
    HttpError = require('connect-lastmile').HttpError,
    https = require('https'),
    HttpSuccess = require('connect-lastmile').HttpSuccess,
    installer = require('./installer.js'),
    json = require('body-parser').json,
    lastMile = require('connect-lastmile'),
    morgan = require('morgan'),
    path = require('path'),
    superagent = require('superagent');

exports = module.exports = {
    start: start,
    stop: stop
};

var PROVISION_CONFIG_FILE = '/root/provision.json';
var CLOUDRON_CONFIG_FILE = '/home/yellowtent/configs/cloudron.conf';

var gHttpsServer = null, // provision server; used for install/restore
    gHttpServer = null; // update server; used for updates

function provisionDigitalOcean(callback) {
    if (fs.existsSync(CLOUDRON_CONFIG_FILE)) return callback(null); // already provisioned

    superagent.get('http://169.254.169.254/metadata/v1.json').end(function (error, result) {
        if (error || result.statusCode !== 200) {
            console.error('Error getting metadata', error);
            return callback(new Error('Error getting metadata'));
        }

        var userData = JSON.parse(result.body.user_data);

        installer.provision(userData, callback);
    });
}

function provisionLocal(callback) {
    if (fs.existsSync(CLOUDRON_CONFIG_FILE)) return callback(null); // already provisioned

    if (!fs.existsSync(PROVISION_CONFIG_FILE)) {
        console.error('No provisioning data found at %s', PROVISION_CONFIG_FILE);
        return callback(new Error('No provisioning data found'));
    }

    var userData = require(PROVISION_CONFIG_FILE);

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

function retire(req, res, next) {
    assert.strictEqual(typeof req.body, 'object');

    if (!req.body.data || typeof req.body.data !== 'object') return next(new HttpError(400, 'No data provided'));

    if (typeof req.body.data.tlsCert !== 'string') console.error('No TLS cert provided');
    if (typeof req.body.data.tlsKey !== 'string') console.error('No TLS key provided');

    debug('retire: received from appstore %j', req.body);

    installer.retire(req.body, function (error) {
        if (error) console.error(error);
    });

    next(new HttpSuccess(202, {}));
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

function startProvisionServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Starting provision server');

    var app = express();

    var router = new express.Router();

    if (process.env.NODE_ENV !== 'test') app.use(morgan('dev', { immediate: false }));

    app.use(json({ strict: true }))
       .use(router)
       .use(lastMile());

    router.post('/api/v1/installer/retire', retire);

    var caPath = path.join(__dirname, process.env.NODE_ENV === 'test' ? 'test/certs' : 'certs');
    var certPath = path.join(__dirname, process.env.NODE_ENV === 'test' ? 'test/certs' : 'certs');

    var options = {
        key: fs.readFileSync(path.join(certPath, 'server.key')),
        cert: fs.readFileSync(path.join(certPath, 'server.crt')),
        ca: fs.readFileSync(path.join(caPath, 'ca.crt')),

        // request cert from client and only allow from our CA
        requestCert: true,
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' // this is set in the tests
    };

    gHttpsServer = https.createServer(options, app);
    gHttpsServer.on('error', console.error);

    gHttpsServer.listen(process.env.NODE_ENV === 'test' ? 4443 : 886, '0.0.0.0', callback);
}

function stopProvisionServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Stopping provision server');

    if (!gHttpsServer) return callback(null);

    gHttpsServer.close(callback);
    gHttpsServer = null;
}

function stopUpdateServer(callback) {
    assert.strictEqual(typeof callback, 'function');

    debug('Stopping update server');

    if (!gHttpServer) return callback(null);

    gHttpServer.close(callback);
    gHttpServer = null;
}

function start(callback) {
    assert.strictEqual(typeof callback, 'function');

    var actions;

    if (process.env.PROVISION === 'local') {
        debug('Starting Installer in selfhost mode');

        actions = [
            startUpdateServer,
            provisionLocal
        ];
    } else {    // current fallback, should be 'digitalocean' eventually, see initializeBaseUbuntuImage.sh
        debug('Starting Installer in managed mode');

        actions = [
            startUpdateServer,
            startProvisionServer,
            provisionDigitalOcean
        ];
    }

    async.series(actions, callback);
}

function stop(callback) {
    assert.strictEqual(typeof callback, 'function');

    async.series([
        stopUpdateServer,
        stopProvisionServer
    ], callback);
}

if (require.main === module) {
    start(function (error) {
        if (error) console.error(error);
    });
}