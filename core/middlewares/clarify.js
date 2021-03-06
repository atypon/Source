'use strict';

var path = require('path');
var fs = require('fs-extra');
var url = require('url');
var Q = require('q');
var _ = require('lodash');
var jsdom;
try {
  jsdom = require("jsdom/lib/old-api.js"); // jsdom >= 10.x
} catch (e) {
  jsdom = require("jsdom"); // jsdom <= 9.x
}

var ejs = require(path.join(global.pathToApp, 'core/ejsWithHelpers.js'));
var trackStats = require(path.join(global.pathToApp, 'core/trackStats'));
var pathToApp = path.dirname(require.main.filename);
var specUtils = require(path.join(pathToApp, 'core/lib/specUtils'));
var configUtils = require(path.join(pathToApp, 'core/lib/configUtils'));
var parseData = require(path.join(pathToApp, 'core/lib/parseData'));
var htmlParser = require(path.join(pathToApp, 'core/html-tree/html-parser'));
var viewResolver = require(path.join(global.pathToApp + '/core/lib/viewResolver.js'));


var htmlDataPath = path.join(pathToApp, global.opts.core.api.htmlData);
var parseHTMLData = new parseData({
    scope: 'html',
    path: htmlDataPath
});

var htmlParserEnabled = global.opts.plugins && global.opts.plugins.htmlParser && global.opts.plugins.htmlParser.enabled;

//TODO JSdoc

var getTpl = function(tpl, contextOptions, info, specDir) {
    var deferred = Q.defer();

    var viewParam = tpl ? tpl : 'default';

    // choose the proper template, depending on page type or defined path
    var context;

    if (info.template) {
        context = specDir;
    }

    var templatePath = viewResolver(viewParam, contextOptions.rendering.views, context) || viewParam;

    fs.readFile(templatePath, 'utf-8', function(err, data){
        if (err) {
            deferred.reject(err);
            return;
        }

        deferred.resolve({data: data, path: templatePath});
    });

    return deferred.promise;
};

var getTplList = function(){
    var deferred = Q.defer();

    var pathToTemplates = path.join(pathToApp, 'core/views/clarify');
    var userPathToTemplates = path.join(global.app.get('user'), 'core/views/clarify');

    var templatesList = [];

    fs.readdir(pathToTemplates, function(err, coreTemplates){
        if (err) {
            deferred.reject({
                err: err,
                msg: 'Could not read directory with Clarify templates'
            });
            return;
        }

        coreTemplates.forEach(function(item){
            templatesList.push(path.basename(item, '.ejs'));
        });

        fs.readdir(userPathToTemplates, function(err, userTemplates){
            if (err) {
                if (err.code === 'ENOENT') {
                    deferred.resolve(templatesList);
                } else {
                    deferred.reject({
                        err: err,
                        msg: 'Could not read user directory with Clarify templates'
                    });
                }
            } else {
                userTemplates.forEach(function(item){
                    templatesList.push(path.basename(item, '.ejs'));
                });

                deferred.resolve(_.uniq(templatesList));
            }
        });
    });

    return deferred.promise;
};

// TODO: Move to standalone API, for fast JSDOM spec parsing
var parseSpec = function(sections, pathToSpec) {
    var deferred = Q.defer();

    // Parsing spec with JSdom
    jsdom.env(
        'http://127.0.0.1:' + global.opts.core.server.port + pathToSpec + '?internal=true',
        ['http://127.0.0.1:' + global.opts.core.server.port + '/source/assets/js/modules/sectionsParser.js'],
        function (err, window) {
            if (err) {
                deferred.reject({
                    err: err,
                    msg: 'JSDOM error'
                });
                return;
            }

            var output = {};

            var SourceGetSections = window.SourceGetSections;

            var parser = new SourceGetSections();
            var allContents = parser.getSpecFull();

            if (sections) {
                output = parser.getSpecFull(sections);
            } else {
                output = allContents;
            }

            if (output) {
                deferred.resolve({
                    output: output,
                    allContents: allContents
                });
            } else {
                deferred.reject({
                    msg: 'Requested sections HTML not found'
                });
            }
        }
    );

    return deferred.promise;
};

var updateApiData = function(specID) {
    var deferred = Q.defer();
    var specs = [specID];

    htmlParser.processSpecs(specs, function(err){
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve();
        }
    });

    return deferred.promise;
};

var getDataFromApi = function(sections, specID, apiUpdate) {
    var deferred = Q.defer();
    var output = {};
    var errMsg = '';

    var getSpecData = function(){
        var allContents = parseHTMLData.getByID(specID);

        if (sections) {
            output = parseHTMLData.getBySection(specID, sections);
            errMsg = 'Requested sections HTML not found, please define existing sections or update HTML API contects.';
        } else {
            output = allContents;
            errMsg = 'Requested Spec not found';
        }

        if (output) {
            deferred.resolve({
                output: output,
                allContents: allContents
            });
        } else {
            deferred.reject({
                msg: errMsg
            });
        }
    };

    if (apiUpdate) {
        updateApiData(specID).then(function(){
            getSpecData();
        }).fail(function(err) {
            var msg = 'Failed updating HTML Spec API. ';

            deferred.reject({
                err: err,
                msg: msg
            });
        });
    } else {
        getSpecData();
    }

    return deferred.promise;
};

var getSectionsIDList = function(sections) {
    var output = [];

    var parseContents = function(contents){
        for (var i=0; contents.length > i ; i++) {
            var current = contents[i];

            output.push({
                header: current.header,
                id: current.id,
                visualID: current.visualID
            });

            if (current.nested.length > 0) {
                parseContents(current.nested);
            }
        }
    };

    parseContents(sections.contents);

    return output;
};

module.exports.process = function(req, res, next) {
	var parsedUrl = url.parse(req.url, true);

    // Query params
    var q = parsedUrl.query || {};
    var clarifyFlag = q.clarify;

    // Check if middleware needs to be activated
	if (clarifyFlag) {
        var urlPath = parsedUrl.pathname;
        var parsedPath = specUtils.parseSpecUrlPath(urlPath);

        var tpl = q.tpl;
        var fromApi = q.fromApi || false;
        var apiUpdate = q.apiUpdate || false;
        var turnOffJS = q.nojs || false;
        var sections = q.sections ? q.sections.split(',') : undefined;

        var specInfo = specUtils.getSpecInfo(parsedPath.pathToSpec);
        var specID = specUtils.getSpecIDFromUrl(parsedPath.pathToSpec);
        var specHasHTMLAPIData = !!parseHTMLData.getByID(specID);
        var ua = req.headers && req.headers['user-agent'] ? req.headers['user-agent'] : undefined;

        var contextOptions = configUtils.getContextOptions(parsedPath.pathToSpec);// = req.specData.contextOptions;
        var specDir = specUtils.getFullPathToSpec(req.url);

        trackStats.page({
            pageName: 'clarify',
            sessionID: trackStats.getSessionID(req),
            ua: ua
        });

        if (!specInfo) {
            res.send('Clarify did not found any information about requested spec, please check URL or update file-tree restarting the app.');
            return;
        }

        if (!specHasHTMLAPIData) apiUpdate = true;

        var getSpecData = function(){
            return fromApi ? getDataFromApi(sections, specID, apiUpdate) : parseSpec(sections, parsedPath.pathToSpec);
        };

        Q.all([
            getSpecData(),
            getTplList()
        ]).spread(function(_specData, tplList) {
            var specData = _specData.output;
            var sections = specData.contents ? specData.contents : [];

            if (sections.length > 0) {
                var checkHeadResources = function(specData, target){
                    return specData.headResources && specData.headResources[target];
                };

                var checkBodyResources = function(specData, target){
                    return specData.bodyResources && specData.bodyResources[target];
                };

                var clarifyData = '<script>var sourceClarifyData = '+ JSON.stringify({
                    showApiTargetOption: specHasHTMLAPIData || htmlParserEnabled,
                    specUrl: specInfo.url,
                    sectionsIDList: getSectionsIDList(_specData.allContents),
                    tplList: tplList
                })+'</script>';

                var templateJSON = {
                    nojs: turnOffJS,
                    title: specInfo.title,
                    sections: sections,
                    headCssLinks: checkHeadResources(specData, 'cssLinks') ? specData.headResources.cssLinks.join('\n') : '',
                    headScripts: checkHeadResources(specData, 'scripts') ? specData.headResources.scripts.join('\n'): '',
                    headCssStyles: checkHeadResources(specData, 'cssStyles') ? specData.headResources.cssStyles.join('\n') : '',

                    bodyCssLinks: checkBodyResources(specData, 'cssLinks') ? specData.bodyResources.cssLinks.join('\n') : '',
                    bodyScripts: checkBodyResources(specData, 'scripts') ? specData.bodyResources.scripts.join('\n'): '',
                    bodyCssStyles: checkBodyResources(specData, 'cssStyles') ? specData.bodyResources.cssStyles.join('\n') : '',

                    clarifyData: clarifyData
                };

                getTpl(tpl, contextOptions, specInfo, specDir).then(function(tpl){
                    var html = '';

                    try {
                        html = ejs.render(tpl.data, templateJSON, {
                            filename: tpl.path
                        });
                    } catch (err) {
                        var msg = 'Clarify: ERROR with EJS rendering failed';

                        if (global.MODE === 'development') global.log.error(msg + ': ', err);

                        html = msg;
                    }

                    res.send(html);
                }).fail(function(err) {
                    var msg = 'ERROR: Could not find requested or default template for Clarify';

                    if (global.MODE === 'development') global.log.warn('Clarify: ' + msg + ': ', err);

                    res.status(500).send(msg);
                });
            } else {
                res.send('Clarify did not found any of requested sections.');
            }
        }).fail(function(errData) {
            global.log.warn('Clarify: ' + (errData.msg || 'Error in data preparation'), errData);

            res.status(500).send(errData.msg);
        });
	} else {
        // redirect to next express middleware
        next();
    }
};
