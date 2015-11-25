/* global describe it beforeEach afterEach */

/*
 * Unit tests for the content service.
 */

require('./helpers/before');

var chai = require('chai');
var dirtyChai = require('dirty-chai');

chai.use(dirtyChai);
var expect = chai.expect;

var request = require('supertest');
var authHelper = require('./helpers/auth');
var resetHelper = require('./helpers/reset');
var server = require('../src/server');
var storage = require('../src/storage');
var reindex = require('../src/routes/reindex');

describe('/reindex', function () {
  beforeEach(resetHelper);

  // Sniff the indexContent call.
  var indexed = null;
  var realIndexContent = null;
  beforeEach(function () {
    indexed = {};
    realIndexContent = storage.indexContent;
    storage.indexContent = function (contentID, envelope, callback) {
      indexed[contentID] = envelope;
      realIndexContent(contentID, envelope, callback);
    };
  });
  afterEach(function () {
    storage.indexContent = realIndexContent;
  });

  it('requires an admin key', function (done) {
    authHelper.ensureAdminIsRequired(
      request(server.create()).post('/reindex'),
      done);
  });

  describe('with content', function () {
    beforeEach(function (done) {
      storage.storeContent('idOne', '{ "body": "aaa bbb ccc" }', done);
    });
    beforeEach(function (done) {
      storage.storeContent('idTwo', '{ "body": "ddd eee fff" }', done);
    });
    beforeEach(function (done) {
      storage.storeContent('idThree', '{ "body": "ggg hhh iii" }', done);
    });

    it('reindexes all known content', function (done) {
      reindex.completedCallback = function (state) {
        expect(indexed.idOne).to.equal('{ "body": "aaa bbb ccc" }');
        expect(indexed.idTwo).to.equal('{ "body": "ddd eee fff" }');
        expect(indexed.idThree).to.equal('{ "body": "ggg hhh iii" }');

        expect(state.totalEnvelopes).to.equal(3);
        expect(state.elapsedMs).not.to.be.undefined();

        done();
      };

      request(server.create)
        .post('/reindex')
        .set('Authorization', authHelper.AUTH_ADMIN)
        .expect(202);
    });
  });
});
