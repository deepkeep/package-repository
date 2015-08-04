
var express = require('express');
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var request = require('request-promise');
var AdmZip = require('adm-zip');
var fs = require('fs');
var AWS = require('aws-sdk');
var unique = require('array-uniq');
var async = require('async');
var streamToBuffer = require('stream-to-buffer');
var morgan = require('morgan');

var app = express();

var AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY;
var AWS_SECRET_KEY = process.env.AWS_SECRET_KEY;
var S3_BUCKET = process.env.S3_BUCKET;
var S3_ENDPOINT = process.env.S3_ENDPOINT;
var PUBLIC_S3_ENDPOINT = process.env.PUBLIC_S3_ENDPOINT;
var FORCE_PATH_STYLE = !!process.env.FORCE_PATH_STYLE;

var config = {
  s3ForcePathStyle: FORCE_PATH_STYLE,
  accessKeyId: AWS_ACCESS_KEY,
  secretAccessKey: AWS_SECRET_KEY,
  params: {
    Bucket: S3_BUCKET
  }
};
if (S3_ENDPOINT) {
  config.endpoint = new AWS.Endpoint(S3_ENDPOINT);
}
if (!PUBLIC_S3_ENDPOINT) {
  if (!FORCE_PATH_STYLE) {
    PUBLIC_S3_ENDPOINT = 'https://' + S3_BUCKET + '.s3.amazonaws.com';
  } else {
    PUBLIC_S3_ENDPOINT = S3_ENDPOINT || 'https://s3.amazonaws.com';
  }
}
console.log('Config', config)
console.log('Using internal S3 endpoint: ', S3_ENDPOINT);
console.log('Using public S3 endpoint: ', PUBLIC_S3_ENDPOINT);

var s3 = new AWS.S3(config);

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


app.use(morgan('combined'));

function zippedKeyFromPackage(package) {
  return 'zipped/' + package.username + '/' + package.package + '/' + package.version + '/package.zip';
}



function keyToUrl(key) {
  if (FORCE_PATH_STYLE) {
    return PUBLIC_S3_ENDPOINT + '/' + S3_BUCKET + '/' + encodeURIComponent(key);
  } else {
    return PUBLIC_S3_ENDPOINT + '/' + encodeURIComponent(key);
  }
}


function listPackagesAndVersions(prefix) {
  return new Promise(function(resolve, reject) {
    s3.listObjects({ Bucket: S3_BUCKET, Prefix: prefix }, function(err, result) {
      if (err) return reject(err);
      var packages = result.Contents.map(function(x) {
        var ss = x.Key.split('/')
        return {
          username: ss[1],
          package: ss[2],
          version: ss[3]
        }
      });
      resolve(unique(packages));
    });
  })
}

function listPackages(prefix) {
  return listPackagesAndVersions(prefix)
    .then(function(packages) {
      var projects = {};
      packages.forEach(function(package) {
        projects[package.username + '/' + package.package] = {
          username: package.username,
          package: package.package
        }
      });
      return Object.keys(projects).map(function(key) {
        return projects[key];
      });
    });
}

var v1 = new express.Router();

v1.get('/_packages', function(req, res, next) {
  listPackages('zipped/')
    .then(function(packages) {
      res.json(packages);
    })
    .catch(next);
});

v1.get('/_all', function(req, res, next) {
  listPackagesAndVersions('zipped/')
    .then(function(packages) {
      res.json(packages);
    })
    .catch(next);
});

v1.get('/_packagescount', function(req, res, next) {
  listPackages('zipped/')
    .then(function(packages) {
      res.json({ count: packages.length });
    })
    .catch(next);
});

v1.get('/:username/_packages', function(req, res, next) {
  listPackages('zipped/' + req.params.username)
    .then(function(packages) {
      res.json(packages);
    })
    .catch(next);
});

v1.get('/:username/:package/_versions', function(req, res, next) {
  listPackagesAndVersions('zipped/' + req.params.username + '/' + req.params.package)
    .then(function(packages) {
      res.json(packages);
    })
    .catch(next);
});

v1.get('/:username/:package/package.zip', function(req, res, next) {
  listPackagesAndVersions('zipped/' + req.params.username + '/' + req.params.package)
    .then(function(packages) {
      // TODO: sort on semver and extract top version
      var key = zippedKeyFromPackage(packages[0]);
      res.redirect(keyToUrl(key));
    })
    .catch(next);
});

v1.get('/:username/:package/:version/package.zip', function(req, res, next) {
  var key = zippedKeyFromPackage(req.params);
  res.redirect(keyToUrl(key));
});

v1.put('/:username/:package/:version/package.zip', passport.authenticate('basic', { session: false }), function(req, res, next) {
  // probably want to use https://www.npmjs.com/package/unzip here in the future,
  // to process the zip stream instead of buffering it all up in memory
  streamToBuffer(req, function(err, buff) {
    if (err) {
      return res.status(500).json({
        status: 'error',
        error: 'unable-to-read-stream'
      });
    }

    console.log(req.user);

    var zip = new AdmZip(buff);
    var packageJson = zip.readAsText('package.json');
    var readme = zip.readAsText('README.md');
    try {
      packageJson = JSON.parse(packageJson);
    } catch(err) {
      return res.status(400).json({
        status: 'error',
        error: 'failed-to-parse-package-json',
        message: 'Could not parse package.json: ' + err.toString()
      });
    }
    if (req.params.username !== req.user.username) return res.status(400).json({
      status: 'error',
      error: 'missmatch-username',
      message: 'username in path not matching auth username'
    });
    if (req.params.package !== packageJson.name) return res.status(400).json({
      status: 'error',
      error: 'missmatch-username',
      message: 'package name in path not matching package name in package.json'
    });
    if (req.params.version !== packageJson.version) return res.status(400).json({
      status: 'error',
      error: 'missmatch-username',
      message: 'version in path not matching version in package.json'
    });

    console.log(packageJson);
    var packageKey = req.user.username + '/' + packageJson.name + '/' + packageJson.version;
    var zippedKey = 'zipped/' + packageKey + '/package.zip';
    var extractedKey = 'extracted/' + packageKey + '/';
    s3.headObject({ Key: zippedKey }, function(err, headRes) {
      console.log('HEAD', headRes)
      console.log('HEAD err', err)
      var exists = headRes || err.code !== 'NotFound';
      if (exists) {
        return res.status(409).json({
          status: 'error',
          error: 'package-exists',
          message: 'Package already extists at version ' + packageJson.version
        });
      }

      var uploads = [{
        body: buff,
        key: zippedKey
      }];
      zip.getEntries().forEach(function(entry) {
        uploads.push({
          body: zip.readFile(entry),
          key: extractedKey + entry.entryName
        });
      });
      console.log('Uploading:', uploads);
      async.map(uploads, function(upload, callback) {
        s3.upload({
          Body: upload.body,
          Bucket: S3_BUCKET,
          Key: upload.key,
          ACL: 'public-read'
        }).send(callback);
      }, function(err, uploadRes) {
        if (err) {
          console.log('S3 upload failed: ', err);
          return res.status(400).json({
            status: 'error',
            error: 's3-upload-failed'
          });
        }
        if (err) {
          console.log('S3 upload failed: ', err);
          return res.status(400).json({
            status: 'error',
            error: 's3-upload-failed'
          });
        }
        console.log('Uploaded files', err, uploadRes);

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
        });
    });
  });
});

v1.use(function servePackageFiles(req, res, next) {
  var match = req.path.match(/\/(.*)\/(.*)\/(.*)\/package[.]zip\/(.*)/);
  if (!match) return next('route');
  var username = match[1];
  var project = match[2];
  var version = match[3];
  var file = match[4];
  var key = 'extracted/' + username + '/' + project + '/' + version + '/' + file;
  res.redirect(keyToUrl(key));
});

app.use('/v1', v1);

if (process.env.AUTO_CREATE_BUCKET) {
  s3.headBucket({ Bucket: S3_BUCKET }, function(err, result) {
    if (!err || err.code != 'NotFound') {
      console.log('AUTO_CREATE_BUCKET Bucket already exists', err);
      return;
    }
    s3.createBucket({ Bucket: S3_BUCKET }, function(err, result) {
      if (err) {
        console.log('AUTO_CREATE_BUCKET Error', err);
      } else {
        console.log('AUTO_CREATE_BUCKET Created', result);
      }
    });
  });
}

var port = process.env.PORT || 6096;
app.listen(port, function() {
  console.log("Listening on " + port);
});
