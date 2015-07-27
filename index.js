
var express = require('express');
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var multer  = require('multer');
var request = require('request-promise');
var AdmZip = require('adm-zip');
var fs = require('fs');
var AWS = require('aws-sdk');

var app = express();

var upload = multer({ dest: './uploads/' });

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

app.use(function requestLogger(req, res, next) {
  console.log(req.method + ' ' + req.url);
  next();
});

app.post('/v1/upload', passport.authenticate('basic', { session: false }), upload.single('package'), function(req, res, next) {
  console.log(req.file);
  console.log(req.user);

  var zip = new AdmZip(req.file.path);
  var packageJson = zip.readAsText('package.json');
  var readme = zip.readAsText('README.md');
  try {
    packageJson = JSON.parse(packageJson);
  } catch(err) {
    return res.status(400).json({
      status: 'error',
      error: 'failed-to-parse-package-json',
      message: 'Could not parse package.json'
    });
  }
  console.log(packageJson);
  var body = fs.createReadStream(req.file.path);
  var key = req.user.username + '-' + packageJson.name + '-' + packageJson.version + '.zip';
  s3.headObject({ Key: key }, function(err, headRes) {
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

    s3.upload({
      Body: body,
      Bucket: S3_BUCKET,
      Key: key,
      ACL: 'public-read'
    }).send(function(err, data) {
        if (err) {
          console.log('S3 upload failed: ', err);
          return res.status(400).json({
            status: 'error',
            error: 's3-upload-failed'
          });
        }

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


app.get('/v1/_list', function(req, res, next) {
  s3.listObjects({ Bucket: S3_BUCKET }, function(err, result) {
    if (err) {
      console.log('Error', err);
      return res.status(500).json({
        status: 'error'
      });
    }
    res.json(result.Contents.map(function(x) {
      return {
        key: x.key
      }
    }));
  });
});

function keyToUrl(key) {
  if (FORCE_PATH_STYLE) {
    return PUBLIC_S3_ENDPOINT + '/' + S3_BUCKET + '/' + encodeURIComponent(key);
  } else {
    return PUBLIC_S3_ENDPOINT + '/' + encodeURIComponent(key);
  }
}

app.get('/v1/:username/:project/package.zip', function(req, res, next) {
  var keyPrefix = req.params.username + '-' + req.params.project + '-';
  s3.listObjects({ Prefix: prefixKey }, function(err, res) {
    // TODO: sort on semver and extract top version
    var key = res.data.Contents[0].Key;
    res.redirect(keyToUrl(key));
  });
});

app.get('/v1/:username/:project/:version/package.zip', function(req, res, next) {
  var key = req.params.username + '-' + req.params.project + '-' + req.params.version + '.zip';
  res.redirect(keyToUrl(key));
});


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
