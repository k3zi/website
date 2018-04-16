const express = require('express');
const path = require("path");
const compression = require('compression');
const createHandler = require('github-webhook-handler');
const sassMiddleware = require('node-sass-middleware');
const nodegit = require("nodegit");
const showdown  = require('showdown');
const timeout = require('connect-timeout');
const url = require('url');
const fs = require('fs');
const fileExists = require('file-exists');
const config = require(__dirname + '/config');

const app = express();
const handler = createHandler({ path: '/webhook', secret: config.webhookSecret });

var home = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
var sshPublicKeyPath = path.join(home, '.ssh', 'id_rsa.pub');
var sshPrivateKeyPath = path.join(home, '.ssh', 'id_rsa');
showdown.setFlavor('github');

/* Setup 'app' */
app.use(timeout('5s'));
app.use(compression());
app.use('/js', express.static(__dirname + '/node_modules/bootstrap/dist/js'));
app.use('/js', express.static(__dirname + '/node_modules/popper.js/dist'));
app.use('/js', express.static(__dirname + '/node_modules/jquery/dist'));
app.use('/css', express.static(__dirname + '/node_modules/bootstrap/dist/css'));
app.use(sassMiddleware({
    src: path.join(__dirname, 'sass'),
    dest: path.join(__dirname, 'public', 'css'),
    response: true,
    outputStyle: 'compressed',
    prefix:  '/css',
    includePaths: [ path.join(__dirname, 'node_modules/') ]
}));

app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(handler);

handler.on('push', function (event) {
    console.log('Received a push event for %s to %s', event.payload.repository.name, event.payload.ref);

    var repository;
    nodegit.Repository.open(path.join(__dirname, 'notes')).then(function(repo) {
        repository = repo;
        console.log('Opened repo');
        return repository.fetchAll({
            callbacks: {
                credentials: function(url, userName) {
                    console.log('Asked for credentials: ', url, ' User: ', userName);
                    return nodegit.Cred.sshKeyNew(userName, sshPublicKeyPath, sshPrivateKeyPath, "");
                },
                certificateCheck: function() {
                    return 1;
                }
            }
        });
    }).then(function() {
        console.log('Do merge');
        return repository.mergeBranches("master", "origin/master");
    }).catch(function(e) {
        console.log(e);
    });
});

app.set('view engine', 'ejs');

app.get('/', (req, res) => {
    res.render('pages/index');
});

app.get('/notes*', (req, res) => {
    var filePath = decodeURIComponent(url.parse(req.url).pathname.slice(1));
    console.log(filePath);
    var converter = new showdown.Converter();

    function getHistory(mdFile, cb) {
        console.log('ok: ', mdFile);
        mdFile = mdFile.split('/');
        var file = mdFile.pop();
        mdFile = mdFile.join('/');

        if (file == "README.md") {
            if (mdFile == "notes") {
                return [];
            }

            return getHistory(mdFile);
        }

        if (mdFile == "notes") {
            return [{ title: 'Notes', path: mdFile + '/' }];
        }

        var readmeFile = path.join(mdFile, 'README.md');
        if (fileExists.sync(readmeFile)) {
            var data = fs.readFileSync(readmeFile, 'utf8');
            var title = data.slice(0, data.indexOf("\n")).slice(data.indexOf("# ") + 2);
            return getHistory(mdFile).concat([{ title: title, path: mdFile + '/' }]);
        }

        return getHistory(mdFile).concat([mdFile.split('/').pop().toUpperCase()]);
    }

    function checkMD(mdFile, paths) {
        fileExists(mdFile).then(exists => {
            if (exists) {
                return fs.readFile(mdFile, 'utf8', function(err, data) {
                    var title = data.slice(0, data.indexOf("\n")).slice(data.indexOf("# ") + 2);
                    var history = getHistory(mdFile);
                    history.push({ title: title, path: filePath });
                    console.log(history);
                    res.render('pages/note', {
                        md: converter.makeHtml(data),
                        history: history,
                        title: title
                    });
                });
            } else if (paths.length > 0) {
                return checkMD(paths.shift(), paths);
            }
        });
    }

    var searchPaths = [filePath + '.md', filePath + 'README.md', filePath + '/README.md'];
    checkMD(searchPaths.shift(), searchPaths);
});

app.use(function(req, res) {
   res.render('pages/404');
});

// Handle 500
app.use(function(error, req, res, next) {
    res.render('pages/500');
});

app.listen(1270, () => {
    console.log('Website listening on port 1270!');
});
