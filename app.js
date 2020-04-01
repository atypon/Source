/*!
* SourceJS - Living Style Guides Engine and Integrated Maintenance Environment for Front-end Components
* @copyright 2013-2015 Sourcejs.com
* @license MIT license: http://github.com/sourcejs/source/wiki/MIT-License
* */

'use strict';

var express = require('express');
var colors = require('colors'); // jshint ignore:line
var fs = require('fs-extra');
var path = require('path');
var commander = require('commander');
var bodyParser = require('body-parser');
var favicon = require('serve-favicon');

/* Globals */
// Define absolute path to app, normalizing windows disk name
global.pathToApp = __dirname.replace(/^\w:\\/, function (match) {
    return match.toLowerCase();
});

var app = global.app = express();

var loadOptions = require('./core/loadOptions');
global.opts = loadOptions();

// Arguments parse */
commander
    .option('-l, --log [string]', 'Log level (default: ' + global.opts.core.common.defaultLogLevel + ').', global.opts.core.common.defaultLogLevel)
    .option('-p, --port [number]', 'Server port (default: ' + global.opts.core.server.port + ').')
    .option('--hostname [string]', 'Server hostname  (default: ' + global.opts.core.server.hostname + ').')
    .option('--html', 'Turn on HTML parser on app start (requires installed and enabled parser).')
    .option('--test', 'Run app with tests.')
    .option('--no-watch', 'Run with disabled watcher.')
    .option('--post-grunt [string]', 'Define Grunt command to run after app start', 'ci-post-run')
    .option('--i18n [string]', 'Sets the locale to be used by the i18n library.')
    .parse(process.argv);

global.commander = commander;

var trackStats = require(path.join(global.pathToApp, 'core/trackStats'));

app.set('views', path.join(__dirname, 'core/views'));
app.set('user', path.join(__dirname, global.opts.core.common.pathToUser));

// We support `development` (default), `production` and `presentation` (for demos)
var MODE = global.MODE = process.env.NODE_ENV || 'development';

global.engineVersion = fs.readJsonSync(path.join(global.pathToApp, '/package.json'), { throws: false }).version;

// Default logger
var logger = require('./core/logger');
var log = logger.log;
var utilLog = logger.util;
global.log = log;

if (commander.i18n) {
    global.i18nLocale = commander.i18n;
}

if (commander.html) {
    trackStats.event({
        group: 'features',
        event: 'enabled html parser'
    });

    global.opts.plugins.htmlParser.enabled = true;
    global.opts.plugins.htmlParser.onStart = true;
}
if (commander.port) global.opts.core.server.port = parseInt(commander.port);
if (commander.hostname) global.opts.core.server.hostname = commander.hostname;
if (!commander.watch) {
    trackStats.event({
        group: 'features',
        event: 'disabled watch'
    });
    global.opts.core.watch.enabled = false;
}
/* /Globals */


/* App config */

var log4js = require('log4js');
app.use(log4js.connectLogger(utilLog, { level: 'DEBUG' }));

// Version
app.use(function (req, res, next) {
    res.header('X-powered-by', 'SourceJS ' + global.engineVersion);
    next();
});

// Optimization
app.use(require('compression')());

// Cookies
app.use(require('cookie-parser')());
var session = require('express-session');
var MemoryStore = require('memorystore')(session);
app.use(session({
    store: new MemoryStore({
        checkPeriod: 86400000 // prune expired entries every 24h
    }),
    secret: (function () {
        var d = new Date().getTime();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (d + Math.random() * 16) % 16 | 0;
            d = Math.floor(d / 16);
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    })(),
    resave: false,
    saveUninitialized: true
}));

app.use(function (req, res, next) {
    if (req.cookies) { req.cookies['source-mode'] = global.MODE; }
    res.cookie('source-mode', global.MODE, { maxAge: 3600000, httpOnly: false });

    next();
});

var shortid = require('shortid');
app.use(function (req, res, next) {
    if (req.cookies && !req.cookies['source-track']) {
        var id = shortid.generate();

        req.cookies['source-track'] = id;
        res.cookie('source-track', id, { maxAge: 3600000, httpOnly: true });
    }

    next();
});

// Favicon
var faviconPath = path.join(app.get('user'), 'favicon.ico');
if (fs.existsSync(faviconPath)) {
    app.use(favicon(faviconPath));
}

app.use(bodyParser.json());
/* /App config */



/* Includes */

// Middlewares
require('./core/middlewares/loader').process(app, global.opts);

// Auth initializing
var auth = require('./core/auth')(app);
app.use(auth.everyauth.middleware());


// File tree module
var fileTree = require('./core/file-tree');

// Run file tree scan on start
fileTree.scan();

// Run file tree scan on main page visit
if (global.opts.core.fileTree.mainPageTrigger && global.MODE !== 'presentation') {
    app.use(function (req, res, next) {

        // Updating navigation on each main page visit
        if (req.url === '/') fileTree.scan();

        next();
    });
}

// Update file tree via api
app.use('/api/updateFileTree', function (req, res) {
    fileTree.scan();

    res.jsonp({
        message: 'Navigation succesfully updated.'
    });
});


// Routes
require('./core/routes');

// API
require('./core/api');
require('./core/api/optionsApi');

// User extenstions
require("./core/loadPlugins.js");

try {
    // User additional functionality
    require(app.get('user') + "/core/app.js");
} catch (e) { }


// Watchers
if (global.opts.core.watch.enabled && global.MODE === 'development') {

    if (global.opts.core.watch.foreverWatchEnabled) {
        require('./core/watch');
    } else {
        require('./core/watch/childWatch');
    }
}

/* /Includes */



/* Serving content */
var headerFooter = require('./core/headerFooter');

// Static content
app.use(express.static(app.get('user')));

// Page 404
app.use(function (req, res) {
    if (req.accepts('html')) {
        if (req.url === '/') {
            res.redirect('/docs');
            return;
        }

        var headerFooterHTML = headerFooter.getHeaderAndFooter();
        res.status(404).render(path.join(__dirname, '/core/views/404.ejs'), {
            header: headerFooterHTML.header,
            footer: headerFooterHTML.footer
        });
    }
});
/* /Serving content */



/* Error handling */
var logErrors = function (err, req, res, next) {
    if (err) {
        var url = req.url || '';

        log.debug(req.method, req.headers);
        log.error(('Requested url: ' + url).red, ('Error: ' + err.stack).red);

        if (req.xhr) {
            res.status(500).json({ msg: 'Server error' });
        } else {
            res.status(500).send('Server error');
        }
    } else {
        console.log('ok')
        next();
    }
};

app.use(logErrors);
/* /Error handling */



let server;
/* Server start */
if (!module.parent) {
    var serverOpts = global.opts.core.server;
    var port = serverOpts.port;

    server = app.listen(port, serverOpts.hostname, serverOpts.backlog, serverOpts.callback);
    log.info('[SOURCEJS] launched on http://127.0.0.1:'.blue + (port.toString()).red + ' in '.blue + MODE.blue + ' mode...'.blue);

    if (commander.test) {
        var spawn = require('cross-spawn');

        spawn('./node_modules/grunt-cli/bin/grunt', [commander.postGrunt, '--port=' + port], { stdio: 'inherit' })
            .on('close', function (code) {
                if (code === 0) {
                    log.info('Test successful');
                    process.exit(0);
                } else {
                    log.error('Test failed');
                    process.exit(1);
                }
            });
    } else {
        if (global.opts.core.tracking.enabled) {
            trackStats.event({
                group: 'start',
                event: 'default'
            });
        } else {
            trackStats.event({
                group: 'start',
                event: 'disabled tracking'
            }, true);
        }
    }
}
/* Server start */

// Handle errors/exceptions

function terminate(server, options = { coredump: false, timeout: 500 }) {
    // Exit function
    const exit = code => {
        options.coredump ? process.abort() : process.exit(code);
    };

    return (code, reason) => (err, promise) => {
        if (err && err instanceof Error) {
            log.error(reason, err.message, err.stack);
            console.log('Server shutdown initiated:', (reason).red, '\n', err.message, '\n', err.stack);
        } else {
            console.log('Server shutdown initiated:', (reason).red);
        }

        // Attempt a graceful shutdown
        server.close(exit);
        setTimeout(exit, options.timeout).unref();
    };
}

const exitHandler = terminate(server, {
    coredump: false,
    timeout: 500
});

process.on('uncaughtException', exitHandler(1, 'Uncaught exception:'));
process.on('unhandledRejection', exitHandler(1, 'Unhandled promise rejection:'));
process.on('SIGTERM', exitHandler(0, 'SIGTERM'));
process.on('SIGINT', exitHandler(0, 'SIGINT'));

setInterval(() => {
    utilLog.trace('Memory usage:', JSON.stringify(process.memoryUsage()));
}, 10000);