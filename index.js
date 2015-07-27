
var express = require('express');
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var multer  = require('multer');
var request = require('request-promise');
var AdmZip = require('adm-zip');
var fs = require('fs');
var FSStorage = require('./fsstorage');
var S3Storage = require('./s3storage');

var app = express();

var upload = multer({ dest: './uploads/' });

var storage;
if (process.env.STORAGE == 'S3') storage = new S3Storage();
else storage = new FSStorage(app);


passport.use(new BasicStrategy(
  function(userid, password, done) {
    request.post({
      url: 'https://' + process.env.AUTH0_DOMAIN + '/oauth/ro',
      json: {
        client_id: process.env.AUTH0_CLIENT_ID,
        username: userid,
        password: password,
        connection: 'Username-Password-Authentication',
        grant_type: 'password',
        scope: 'openid profile'
      }
    }).then(function(res) {
      request.get({
        url: 'https://' + process.env.AUTH0_DOMAIN + '/userinfo',
        headers: {
          Authorization: 'Bearer ' + res.access_token
        }
      }).then(function(account) {
        done(null, JSON.parse(account));
      }).catch(function(err) {
        done(err);
      });
    }).catch(function(err) {
      console.log('BasicStrategy login error', err);
      if (!err) done({ error: 'unknown' });
      else if (err.error.error == 'invalid_user_password') done(null, false);
      else done(err.error);
    });
  }
));

// This is not a best practice, but we want to keep things simple for now
passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(user, done) {
  done(null, user);
});

app.use(passport.initialize());

app.use(function requestLogger(req, res, next) {
  console.log(req.method + ' ' + req.url);
  next();
});

console.log(multer({ dest: './uploads/' }))
app.post('/v1/upload', passport.authenticate('basic', { session: false }), upload.single('package'), function(req, res, next) {
  console.log(req.file);
  console.log(req.user);

  var zip = new AdmZip(req.file.path);
  var packageJson = zip.readAsText('package.json');
  var readme = zip.readAsText('README.md');
  try {
    packageJson = JSON.parse(packageJson);
  } catch(err) {
    res.status(400).send('Could not parse package.json');
    return;
  }
  console.log(packageJson);
  var body = fs.createReadStream(req.file.path);
  var key = req.user.username + '-' + packageJson.name + '-' + packageJson.version + '.zip';
  storage.exists(key).then(function(exists) {
    if (exists) {
      res.status(409).send('Package already extists at version ' + packageJson.version);
      return;
    }
    return storage.upload(key, body)
      .then(function() {
        var packageUrl = 'http://' + req.headers.host + '/v1/' + req.user.username + '/' + packageJson.name + '/' + packageJson.version + '/package.zip';
        if (process.env.WEBHOOK_URL) {
          console.log('Posting to webhook: ', process.env.WEBHOOK_URL);
          request.post({
            uri: process.env.WEBHOOK_URL,
            json: {
              event: 'package-uploaded',
              url: packageUrl,
              packageJson: packageJson,
              readme: readme,
              username: req.user.username,
              user_id: req.user.user_id
            }
          });
        }
        res.json({
          status: 'success',
          url: packageUrl
        });
      })
  }).catch(next);
});

app.get('/v1/:username/:project/package.zip', function(req, res, next) {
  var keyPrefix = req.params.username + '-' + req.params.project + '-';
  storage.listPrefix(keyPrefix)
    .then(function(files) {
      // TODO: properly sort files based on versions
      res.redirect(storage.urlForKey(files[0].key));
    }).catch(next);
});

app.get('/v1/:username/:project/:version/package.zip', function(req, res, next) {
  var key = req.params.username + '-' + req.params.project + '-' + req.params.version + '.zip';
  res.redirect(storage.urlForKey(key));
});



var port = process.env.PORT || 6096;
app.listen(port, function() {
  console.log("Listening on " + port);
});
