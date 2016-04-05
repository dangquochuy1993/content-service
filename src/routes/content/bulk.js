'use strict';

const async = require('async');
const path = require('path');
const targz = require('tar.gz');
const logger = require('../../logging').getLogger();
const storage = require('../../storage');
const storeEnvelope = require('./store').storeEnvelope;
const removeEnvelopes = require('./remove').removeEnvelopes;

/**
 * @description Store new content into the content store from an uploaded tarball.
 */
exports.handler = function (req, res, next) {
  const reqStart = Date.now();

  let contentIDBase = null;
  let envelopeCount = 0;
  let failureCount = 0;
  let deletionCount = 0;
  let toKeep = {};

  const envelopeWorker = (task, cb) => {
    logger.debug('Beginning envelope storage', {
      contentID: task.contentID
    });

    let storageStart = Date.now();

    storeEnvelope(task.contentID, task.envelope, (err) => {
      if (err) {
        failureCount++;
        reportError(err, null, 'storing metadata envelope');
        return cb();
      }

      envelopeCount++;

      logger.debug('Envelope stored successfully', {
        contentID: task.contentID,
        envelopeCount,
        failureCount,
        storageDuration: Date.now() - storageStart
      });

      cb();
    });
  };

  const uploadQueue = async.queue(envelopeWorker, 10);

  // Log an error and optionally report it to the user.
  const reportError = (err, entryPath, description, fatal) => {
    const logPayload = {
      action: 'bulkcontentstore',
      apikeyName: req.apikeyName,
      entryPath,
      err: err.message,
      stack: err.stack,
      statusCode: 400,
      totalReqDuration: Date.now() - reqStart
    };

    if (fatal) {
      logger.error(`Fatal bulk upload problem: ${description}`, logPayload);

      err.statusCode = 400;

      next(err);
    } else {
      logger.warn(`Bulk upload problem: ${description}`, logPayload);
    }
  };

  // Handle a metadata/config.json entry.
  const handleConfigEntry = (entry) => {
    jsonFromStream(entry, (err, config) => {
      if (err) return reportError(err, entry.path, 'parsing config.json');

      if (!config.contentIDBase) {
        let e = new Error('Missing required key: contentIDBase');
        return reportError(e, entry.path, 'parsing config.json');
      }

      contentIDBase = config.contentIDBase;
    });
  };

  // Handle a metadata/keep.json entry.
  const handleKeepEntry = (entry) => {
    jsonFromStream(entry, (err, keep) => {
      if (err) return reportError(err, entry.path, 'parsing keep.json');

      if (!keep.keep) {
        let e = new Error('Missing required key: keep');
        return reportError(e, entry.path, 'parsing keep.json');
      }

      keep.keep.forEach((contentID) => {
        toKeep[contentID] = true;
      });
    });
  };

  const handleEnvelopeEntry = (entry) => {
    let encodedContentID = path.basename(entry.path, '.json');
    let contentID = decodeURIComponent(encodedContentID);
    toKeep[contentID] = true;

    jsonFromStream(entry, (err, envelope) => {
      if (err) {
        failureCount++;
        return reportError(err, entry.path, 'parsing metadata envelope');
      }

      // TODO validate envelope contents against a schema

      uploadQueue.push({ contentID, envelope });
    });
  };

  const removeDeletedContent = (cb) => {
    if (!contentIDBase) {
      logger.debug('Skipping content deletion.');
      return cb(null);
    }

    let existingContentIDs = [];

    storage.listContent(contentIDBase, (err, ids, next) => {
      if (err) return cb(err);

      if (ids.length > 0) {
        // Page of content.
        existingContentIDs = existingContentIDs.concat(ids);
        next();
      } else {
        // All content consumed.
        let toDelete = existingContentIDs.filter((id) => !toKeep[id]);
        deletionCount = toDelete.length;

        logger.debug('Deleting removed envelopes.', { deletionCount });

        removeEnvelopes(toDelete, (err, results) => {
          if (err) return cb(err);

          logger.debug('Envelopes deleted.');

          cb();
        });
      }
    });
  };

  const reportCompletion = () => {
    logger.info('Bulk content upload completed successfully.', {
      action: 'bulkcontentstore',
      apikeyName: req.apikeyName,
      acceptedCount: envelopeCount,
      failedCount: failureCount,
      deletedCount: deletionCount,
      totalReqDuration: Date.now() - reqStart
    });

    res.send(204);
    next();
  };

  const parse = targz().createParseStream();

  parse.on('entry', (entry) => {
    if (entry.type !== 'File') return;

    let dirs = path.dirname(entry.path).split(path.sep);
    let dname = dirs[dirs.length - 1];
    let bname = path.basename(entry.path);

    logger.debug('Received entry for path', { path: entry.path });

    if (dname === 'metadata') {
      // metadata/ entries
      switch (bname) {
        case 'config.json':
          handleConfigEntry(entry);
          break;
        case 'keep.json':
          handleKeepEntry(entry);
          break;
        default:
          logger.warn('Unrecognized metadata entry', {
            entryPath: entry.path
          });
          break;
      }
    } else if (bname.endsWith('.json')) {
      handleEnvelopeEntry(entry);
    } else {
      logger.warn('Unrecognized entry', {
        entryPath: entry.path
      });
    }
  });

  parse.on('error', (err) => {
    logger.info('Corrupted tarball uploaded', {
      err: err.message,
      stack: err.stack
    });

    res.send(400, err);

    next();
  });

  parse.on('end', () => {
    const finishRequest = () => {
      removeDeletedContent((err) => {
        if (err) {
          reportError(err, null, 'deleted content removal', true);
        }

        reportCompletion();
      });
    };

    if (uploadQueue.running()) {
      uploadQueue.drain = finishRequest;
    } else {
      finishRequest();
    }
  });

  req.pipe(parse);
};

const jsonFromStream = function (stream, callback) {
  let chunks = [];

  stream.on('data', (chunk) => chunks.push(chunk));
  stream.on('error', callback);
  stream.on('end', () => {
    try {
      let b = Buffer.concat(chunks, stream.size);
      let s = b.toString('utf-8');
      let payload = JSON.parse(s);
      return callback(null, payload);
    } catch (err) {
      return callback(err);
    }
  });
};
