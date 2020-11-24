const express = require('express');
const path = require("path");
const compression = require('compression');
const createHandler = require('github-webhook-handler');
const sassMiddleware = require('node-sass-middleware');
const nodegit = require("nodegit");
const showdown  = require('showdown');
const timeout = require('connect-timeout');
const url = require('url');
const fileExists = require('file-exists');
const config = require(__dirname + '/config');
const serveStatic = require('serve-static');
var Promise = require('bluebird');
const fs = Promise.promisifyAll(require('fs'));
const request = require("request");
const cachedRequest = require('cached-request')(request);
const cacheDirectory = "/home/kezio/discord/accent/temp";
cachedRequest.setCacheDirectory(cacheDirectory);
const cheerio = require('cheerio');
const octicons = require("octicons");

const Git = require("nodegit");

const app = express();
const handler = createHandler({ path: '/webhook', secret: config.webhookSecret });

var home = process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
var sshPublicKeyPath = path.join(home, '.ssh', 'id_rsa.pub');
var sshPrivateKeyPath = path.join(home, '.ssh', 'id_rsa');
showdown.setFlavor('github');

function getTitleFromData(data, short) {
    var data = data.slice(0, data.indexOf("\n")).slice(data.indexOf("# ") + 2);
    if (short) {
        data = data.split(':')[0];
    }

    return data;
}

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
app.use(serveStatic('public/ftp'));
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

app.get('/projects', (req, res) => {
    res.render('pages/projects', {
        subtitle: 'Projects',
        octicon: octicons
    });
});

app.get('/mancala', (req, res) => {
    res.render('pages/mancala', {
        subtitle: 'Mancala',
        octicon: octicons
    });
});



app.get('/notes*', (req, res, next) => {
    var filePath = decodeURIComponent(url.parse(req.url).pathname.slice(1));
    console.log(filePath);
    var converter = new showdown.Converter();

    function getLastCommitForFile(repoDirectory, fileName) {
        console.log('getLastCommitForFile');
        let repo, walker;
        function getFirstCommits(allCommits) {
            if (allCommits.length == 0) {
                return [];
            }

            walker = repo.createRevWalk();
            return walker.fileHistoryWalk(fileName, 500)
                .then(results => {
                    if (results.length > 0) {
                        return results;
                    } else {
                        allCommits.shift();
                        return getFirstCommits(allCommits);
                    }
                });
        }

        const absolutePath = path.resolve(__dirname, repoDirectory);
        console.log(absolutePath);
        return Git.Repository.open(absolutePath)
            .then((r) => {
                repo = r;
                return r.getMasterCommit();
            })
            .then((firstCommitOnMaster) => {
                walker = repo.createRevWalk();
                walker.push(firstCommitOnMaster.sha());
                walker.sorting(nodegit.Revwalk.SORT.Time);

                return walker.getCommitsUntil(() => {
                    return false;
                }, 5000);
            })
            .then((commits) => {
                console.log('got commits: ', commits.length);
                return getFirstCommits(commits);
            });
    }

    function getPreviousCommitsForFile(repoDirectory, fileName) {
        let walker, lastSha, historyCommits = [], commit, repo;
        function compileHistory(resultingArrayOfCommits) {
            if (historyCommits.length > 0) {
                lastSha = historyCommits[historyCommits.length - 1].commit.sha();
                if (resultingArrayOfCommits.length == 1 && resultingArrayOfCommits[0].commit.sha() == lastSha) {
                    return;
                }
            }

            resultingArrayOfCommits.forEach((entry) => {
                historyCommits.push(entry);
            });

            const l = historyCommits[historyCommits.length - 1];
            if (!l) {
                return;
            }
            lastSha = l.commit.sha();

            walker = repo.createRevWalk();
            walker.push(lastSha);
            walker.sorting(nodegit.Revwalk.SORT.TIME);

            if (l.oldName != l.newName) {
                fileName = l.oldName;
                console.log('new file name: ', fileName);
            }
            return walker.fileHistoryWalk(fileName, 500)
                .then(compileHistory);
        }

        const absolutePath = path.resolve(__dirname, repoDirectory);
        return Git.Repository.open(absolutePath)
            .then((r) => {
                repo = r;
                console.log(r);
                return repo.getMasterCommit();
            })
            .then((firstCommitOnMaster) => {
                console.log('firstCommitOnMaster: ', firstCommitOnMaster);
                // History returns an event.
                walker = repo.createRevWalk();
                walker.push(firstCommitOnMaster.sha());
                walker.sorting(nodegit.Revwalk.SORT.Time);

                return getLastCommitForFile(repoDirectory, fileName);
            })
            .then(compileHistory)
            .then(() => {
                return historyCommits;
            });
    }

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
            var title = getTitleFromData(data, true);
            return getHistory(mdFile).concat([{ title: title, path: mdFile + '/' }]);
        }

        return getHistory(mdFile).concat([mdFile.split('/').pop().toUpperCase()]);
    }

    function renderFile(mdFile, data) {
        var title = getTitleFromData(data, true);
        var history = getHistory(mdFile);
        history.push({ title: title, path: filePath });
        res.render('pages/note', {
            md: converter.makeHtml(data),
            history: history,
            title: title
        });
    }

    function checkMD(mdFile, paths) {
        fileExists(mdFile).then(exists => {
            if (exists) {
                return fs.readFile(mdFile, 'utf8', function(err, data) {
                    if (mdFile.endsWith("README.md")) {
                        var mdFolder = mdFile.split("/");
                        mdFolder.pop();
                        mdFolder = mdFolder.join("/");
                        console.log(`Ends with README.md: ${mdFolder}`);
                        fs.readdirAsync(mdFolder).map(file => {
                            if (file.endsWith('README.md')) {
                                return false;
                            }

                            var resolvedFile = path.resolve(mdFolder, file);
                            return fs.statAsync(resolvedFile).then(function(stat) {
                                if (stat.isDirectory()) {
                                    var readmeFile = path.join(resolvedFile, 'README.md');
                                    return fileExists(readmeFile).then(exists => {
                                        if (exists) {
                                            return fs.readFileAsync(readmeFile, 'utf8').then(data => {
                                                console.log(`Add directory title: ${readmeFile}`);
                                                return {
                                                    title: getTitleFromData(data),
                                                    path: file
                                                };
                                            });
                                        } else {
                                            return false;
                                        }
                                    });
                                } else if (file.endsWith(".md")) {
                                    return fs.readFileAsync(resolvedFile, 'utf8').then(data => {
                                        console.log(`Add files title: ${file}`);
                                        return {
                                            title: getTitleFromData(data),
                                            path: file.replace('.md', '')
                                        };
                                    });
                                } else {
                                    return false;
                                }
                            });
                        }).then(contents => {
                            contents = contents.filter(c => c).sort((a, b) => a.path - b.path);
                            data += '\n';
                            contents.forEach(c => {
                                data += `### [${c.title}](${path.join('/', filePath, c.path)})\n`;
                            });
                            console.log('Contents: ', contents);
                            renderFile(mdFile, data);
                        });
                    } else {
                        console.log('getting commits');
                        getPreviousCommitsForFile('./notes', mdFile.replace('notes/', '')).then(commits => {
                            console.log(commits);
                            renderFile(mdFile, data);
                        }).catch(e => {
                            console.log(e);
                        });
                    }
                });
            } else if (paths.length > 0) {
                return checkMD(paths.shift(), paths);
            } else {
                next();
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
