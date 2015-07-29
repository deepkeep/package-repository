
var childProcess = require('child_process');

describe('test', function() {
  before(function(done) {
    this.timeout(20000);
    childProcess.exec('docker-compose build && docker-compose up -d', function(err, stderr, stdout) {
      if (err) {
        console.log(err);
        console.log(stderr);
        console.log(stdout);
      }
      done();
    });
  });

  it('should be possible to upload a package', function() {
    
  });
})
