var deploy_target = process.env.NODE_DEPLOY_TARGET || "local";
var util = require('util');
var url = require('url');
var bcrypt = require('bcrypt');
var node_config = require("./nodeconfig_" + deploy_target);
var Connection = require("fielddb/api/corpus/Connection").Connection;
var couch_keys = require("./couchkeys_" + deploy_target);
var mail_config = require("./mailconfig_" + deploy_target);
var nodemailer = require("nodemailer");
var _ = require('underscore');
var md5 = require('MD5');
var corpus_management = require('./corpusmanagement');
var corpus = require('./corpus');
var Q = require('q');

var Connection = require("fielddb/api/corpus/Connection").Connection;
var User = require("fielddb/api/user/User").User;
var UserMask = require("fielddb/api/user/UserMask").UserMask;


if (!Connection || !Connection.knownConnections || !Connection.knownConnections.production) {
  throw new Error("The app config for " + deploy_target + " is missing app types to support. ");
}

/*
 * we are getting too many user signups from the Learn X users and the speech recognition trainer users,
 * they are starting to overpower the field linguist users. So if when we add the ability for them
 * to backup and share their languages lessions, then
 * we will create their dbs  with a non-anonymous username.
 */
var dontCreateDBsForLearnXUsersBecauseThereAreTooManyOfThem = true;
var backwardCompatible = false;

var authServerVersion = require("./../package.json").version;

//Only create users on the same server.
var parsed = url.parse("http://localhost:5984");
var couchConnectUrl = parsed.protocol + "//" + couch_keys.username + ":" + couch_keys.password + "@" + parsed.host;

console.log(new Date() + " Loading the User Authentication Module v" + authServerVersion);
var nano = require('nano')(couchConnectUrl);

var cleanErrorStatus = function(status) {
  if (status && status.length === 3) {
    return status;
  }
  return "";
};

//Send email see docs https://github.com/andris9/Nodemailer
var smtpTransport = nodemailer.createTransport("SMTP", mail_config.mailConnection);
var mailOptions = mail_config.newUserMailOptions();
var emailWhenServerStarts = mailOptions.to;
if (emailWhenServerStarts !== "") {
  mailOptions.subject = "FieldDB server restarted";
  mailOptions.text = "The FieldDB server has restarted. (It might have crashed)";
  mailOptions.html = "The FieldDB server has restarted. (It might have crashed)";
  smtpTransport.sendMail(mailOptions, function(error, response) {
    if (error) {
      console.log(new Date() + " Server (re)started Mail error" + util.inspect(error));
    } else {
      console.log(new Date() + " Server (re)started, message sent: \n" + response.message);
    }
    smtpTransport.close(); // shut down the connection pool, no more messages
  });
} else {
  console.log(new Date() + " Didn't email the devs: The FieldDB server has restarted. (It might have crashed)");
}

/*
 * User Authentication functions
 */
module.exports = {};


/**
 * Takes parameters from the request and creates a new user json, salts and
 * hashes the password, has the corpus_management library create a new couchdb
 * user, permissions and couches for the new user. The returns the save of the
 * user to the users database.
 */
module.exports.registerNewUser = function(localOrNot, req, done) {
  if (req.body.username === "yourusernamegoeshere") {
    return done({
      status: 412,
      error: 'Username is the default username'
    }, null, {
      message: 'Please type a username instead of yourusernamegoeshere.'
    });
  }

  if (!req || !req.body.username || !req.body.username) {
    return done({
      status: 412,
      error: 'Please provide a username'
    }, null, {
      message: 'Please provide a username'
    });
  }

  if (req.body.username.length < 3) {
    return done({
      status: 412,
      error: 'Please provide a longer username `' + req.body.username + '` is too short.'
    }, null, {
      message: 'Please choose a longer username `' + req.body.username + '` is too short.'
    });
  }

  var safeUsernameForCouchDB = Connection.validateUsername(req.body.username);
  if (req.body.username !== safeUsernameForCouchDB.identifier) {
    safeUsernameForCouchDB.status = 406;
    return done(safeUsernameForCouchDB, null, {
      message: 'Please use \'' + safeUsernameForCouchDB.identifier + '\' instead (the username you have chosen isn\'t very safe for urls, which means your corpora would be potentially inaccessible in old browsers)'
    });
  }

  // Make sure the username doesn't exist.
  findByUsername(req.body.username, function(err, user, info) {
    if (user) {
      err = err || {};
      err.error = err.error || 'Username ' + req.body.username + ' already exists, try a different username.';
      err.status = cleanErrorStatus(err.status) || 409;
      return done(err, null, {
        message: 'Username ' + req.body.username + ' already exists, try a different username.'
      });
    } else {
      console.log(new Date() + ' Registering new user: ' + req.body.username);
      req.body.email = req.body.email ? req.body.email.toLowerCase().trim() : null;
      var salt = bcrypt.genSaltSync(10);
      /*
       * Add more attributes from the req.body below
       */

      // Create connection and activityConnection based on server
      var appbrand = req.body.appbrand;
      if (!appbrand) {
        if (req.body.username.indexOf("test") > -1) {
          appbrand = "beta";
        } else if (req.body.username.indexOf("anonymouskartulispeechrecognition") === 0) {
          appbrand = "kartulispeechrecognition";
        } else if (req.body.username.search(/anonymous[0-9]/) === 0) {
          appbrand = "georgiantogether";
        } else if (req.body.username.search(/anonymouswordcloud/) === 0) {
          appbrand = "wordcloud";
        } else {
          appbrand = "lingsync";
        }
      }

      //TODO this has to be come asynchonous if this design is a central server who can register users on other servers
      var connection = req.body.connection || req.body.couchConnection || Connection.defaultConnection(appbrand);
      connection = new Connection(connection);
      connection.dbname = req.body.username + "-firstcorpus";
      if (appbrand === "phophlo") {
        connection.dbname = req.body.username + "-phophlo";
      }
      if (appbrand === "kartulispeechrecognition") {
        connection.dbname = req.body.username + "-kartuli";
      }
      if (appbrand === "georgiantogether") {
        connection.dbname = req.body.username + "-kartuli";
      }
      connection.dbname = connection.dbname;

      var activityConnection = JSON.parse(JSON.stringify(connection));
      activityConnection.dbname = activityConnection.dbname = req.body.username + "-activity_feed";

      /* Set gravatar using the user's registered email, or username if none */
      var gravatar = null;
      if (req.body.email) {
        gravatar = md5(req.body.email);
      }
      if (!gravatar) {
        gravatar = md5(req.body.username);
      }
      req.body.email = req.body.email || "";

      /* Prepare a private corpus doc for the user's first corpus */
      var corpusTitle = "Practice Corpus";
      if (appbrand === "phophlo") {
        corpusTitle = "Phophlo";
      }
      if (appbrand === "georgiantogether") {
        corpusTitle = "Geogian";
      }
      if (appbrand === "kartulispeechrecognition") {
        corpusTitle = "Kartuli Speech Recognition";
      }
      connection.title = corpusTitle;
      var bulkDocs = corpus.createPlaceholderDocsForCorpus({
        title: corpusTitle,
        connection: connection,
        dbname: connection.dbname
      });
      var corpusDetails = bulkDocs[2];
      if (appbrand === "phophlo") {
        corpusDetails.description = "This is your Phophlo database, here you can see your imported class lists and participants results. You can share your database with others by adding them to your team as readers, writers, commenters or admins on your database.";
      }
      if (appbrand === "georgiantogether") {
        corpusDetails.description = "This is your Georgian database, here you can see the lessons you made for your self. You can share your database with others by adding them to your team as readers, writers, commenters or admins on your database.";
      }
      if (appbrand === "kartulispeechrecognition") {
        corpusDetails.description = "This is your personal database, here you can see the sentences you made for your own speech recognition system trained to your voice and vocabulary. You can share your database with others by adding them to your team as readers, writers, commenters or admins on your database.";
      }
      connection.description = corpusDetails.description;

      var corpora = [JSON.parse(JSON.stringify(connection))];

      /* Prepare mostRecentIds so apps can load a most recent dashboard if applicable */
      var mostRecentIds = {};
      mostRecentIds.connection = JSON.parse(JSON.stringify(connection));

      /* Prepare a public corpus doc for the user's first corpus */
      var corpusMaskDetails = bulkDocs[1];

      /* Prepare an empty datalist doc for the user's first corpus */
      var datalistDetails = bulkDocs[3];

      /* Prepare an empty session doc for the user's first corpus */
      var sessionDetails = bulkDocs[4];

      var defaultPrefs = {
        "skin": "user/skins/weaving.jpg",
        "numVisibleDatum": 2,
        "transparentDashboard": "false",
        "alwaysRandomizeSkin": "true",
        "numberOfItemsInPaginatedViews": 10,
        "unicodes": [{
          "symbol": "ɔ",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "ə",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "ɛ",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "ɣ",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "ɥ",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "ɦ",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "ɫ",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "ʃ",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "ʒ",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "ʔ",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "λ ",
          "tipa": "lambda",
          "useCount": 0
        }, {
          "symbol": "α ",
          "tipa": "alpha",
          "useCount": 0
        }, {
          "symbol": "β ",
          "tipa": "\beta",
          "useCount": 0
        }, {
          "symbol": "∀",
          "tipa": "\forall",
          "useCount": 0
        }, {
          "symbol": "∃",
          "tipa": "exists",
          "useCount": 0
        }, {
          "symbol": "°",
          "tipa": "^{circ}",
          "useCount": 0
        }, {
          "symbol": "∄",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "∅",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "∈",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "∉",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "∋",
          "tipa": "",
          "useCount": 0
        }, {
          "symbol": "∌",
          "tipa": "",
          "useCount": 0
        }]
      };
      // TODO why not accepting whatever was sent to have new features?
      user = {
        "jsonType": 'user',
        "username": req.body.username,
        "_id": req.body.username,
        "email": req.body.email,
        "corpora": corpora,
        "activityConnection": activityConnection,
        "appbrand": appbrand,

        "gravatar": gravatar,
        "researchInterest": req.body.researchInterest || "",
        "affiliation": req.body.affiliation || "",
        "appVersionWhenCreated": req.body.appVersionWhenCreated || "unknown",
        "authServerVersionWhenCreated": authServerVersion,
        "authUrl": connection.authUrl,
        // authUrl : req.body.authUrl,
        "description": req.body.description || "",
        "subtitle": req.body.subtitle || "",
        "dataLists": req.body.dataLists || [],
        "prefs": req.body.prefs || defaultPrefs,
        "mostRecentIds": mostRecentIds || {},
        "firstname": req.body.firstname || "",
        "lastname": req.body.lastname || "",
        "sessionHistory": req.body.sessionHistory || [],
        "hotkeys": req.body.hotkeys || {},

        "salt": salt,
        "hash": bcrypt.hashSync(req.body.password, salt),
        "created_at": new Date(),
        "updated_at": new Date()
      };
      user = new User(user).toJSON();
      var team = bulkDocs[0];
      team.gravatar = user.gravatar;

      var usersPublicSelfForThisCorpus = new UserMask({
        "_id": user._id,
        "gravatar": user.gravatar,
        "username": user.username,
        "appbrand": appbrand,
        "collection": "users",
        "firstname": "",
        "lastname": "",
        "email": "",
        "researchInterest": "No public information available",
        "affiliation": "No public information available",
        "description": "No public information available"
      }).toJSON();
      /*
       * Create the databases for the new user's corpus
       */
      var userforcouchdb = {
        "username": req.body.username,
        "password": req.body.password,
        "corpora": [JSON.parse(JSON.stringify(connection))],
        "activityConnection": activityConnection
      };

      var docsNeededForAProperFieldDBDatabase = [team, usersPublicSelfForThisCorpus, corpusMaskDetails, corpusDetails, datalistDetails, sessionDetails];

      if (dontCreateDBsForLearnXUsersBecauseThereAreTooManyOfThem &&
        (connection.dbname.indexOf("anonymouskartulispeechrecognition") > -1 ||
          connection.dbname.search(/anonymous[0-9]/) > -1)) {
        console.log(new Date() + "  delaying creation of the dbs for " + connection.dbname + " and " + activityConnection.dbname + " until they can actually use them.");
        // user.newCorpora = user.corpora;
        emailWelcomeToTheUser(user);
        /*
         * The user was built correctly, saves the new user into the users database
         */
        console.log(new Date() + " Sent command to save user to couch: " + util.inspect(node_config.usersDbConnection));
        return saveUpdateUserToDatabase(user, done);
      }

      corpus_management.createDbaddUser(userforcouchdb.corpora[0], userforcouchdb, function(res) {
        console.log(new Date() + " There was success in creating the corpus: " + util.inspect(res) + "\n");

        /* Save corpus, datalist and session docs so that apps can load the dashboard for the user */
        var db = require('nano')(couchConnectUrl + "/" + corpusDetails.dbname);
        db.bulk({
          "docs": docsNeededForAProperFieldDBDatabase
        }, function(err, couchresponse) {
          if (err) {
            console.log(new Date() + " There was an error in creating the docs for the users first corpus: " + util.inspect(err) + "\n", couchresponse);
            undoCorpusCreation(user, corpusDetails.connection, docsNeededForAProperFieldDBDatabase);
            err = err || {};
            err.status = cleanErrorStatus(err.statusCode) || 500;
            return done(err, null, {
              message: 'Server is not responding for request to create user `' + user.username + '`. Please report this.'
            });
          } else {
            console.log(new Date() + " Created corpus for " + corpusDetails.dbname + "\n");

            emailWelcomeToTheUser(user);
            /*
             * The user was built correctly, saves the new user into the users database
             */
            console.log(new Date() + " Sent command to save user to couch: " + util.inspect(node_config.usersDbConnection));
            return saveUpdateUserToDatabase(user, done);
          }
        });


      }, function(err) {
        console.log(new Date() + " There was an error in creating the corpus database: " + util.inspect(err) + "\n");
        undoCorpusCreation(user, corpusDetails.connection, docsNeededForAProperFieldDBDatabase);

        err = err || {};
        err.status = cleanErrorStatus(err.status) || 500;
        return done(err, null, {
          message: 'Server is not responding for request to create user, `' + user.username + '`. Please report this.'
        });

      });
      console.log(new Date() + " Sent command to create user's corpus to couch: " + util.inspect(user.corpora[user.corpora.length - 1]));

    }
  });
};

var emailWelcomeToTheUser = function(user) {
  if (user.username.indexOf("anonymous") > -1) {
    console.log(new Date() + " Didn't email welcome to new anonymous user" + user.username);
    return;
  }

  /* all is well, the corpus was created. welcome the user */
  var email = user.email || "";
  email = email + "";
  if (!email) {
    email = "bounce@lingsync.org";
  }
  if (email && email.length > 5 && mail_config.mailConnection.auth.user !== "") {
    // Send email https://github.com/andris9/Nodemailer
    var smtpTransport = nodemailer.createTransport("SMTP", mail_config.mailConnection);
    var mailOptions = mail_config.newUserMailOptions();
    if (user.appbrand === "phophlo") {
      mailOptions = mail_config.newUserMailOptionsPhophlo();
    }
    mailOptions.to = email + "," + mailOptions.to;
    mailOptions.text = mailOptions.text.replace(/insert_username/g, user.username);
    mailOptions.html = mailOptions.html.replace(/insert_username/g, user.username);
    smtpTransport.sendMail(mailOptions, function(error, response) {
      if (error) {
        console.log(new Date() + " Mail error" + util.inspect(error));
      } else {
        console.log(new Date() + " Message sent: \n" + response.message);
        console.log(new Date() + " Sent User " + user.username + " a welcome email at " + email);
      }
      smtpTransport.close(); // shut down the connection pool
    });
  } else {
    console.log(new Date() + " Didn't email welcome to new user" + user.username + " why: emailpresent: " + email + ", valid user email: " + (email.length > 5) + ", mailconfig: " + (mail_config.mailConnection.auth.user !== ""));
  }
};

/**
 * This emails the user, if the user has an email, if the
 * email is 'valid' TODO do better email validation. and if
 * the mail_config has a valid user. For the dev and local
 * versions of the app, this wil never be fired because the
 * mail_config doesnt have a valid user. But the production
 * config does, and it is working.
 *
 * @param  {[type]}   user              [description]
 * @param  {[type]}   temporaryPassword message       [description]
 * @param  {Function} done              [description]
 * @return {[type]}                     [description]
 */
var emailTemporaryPasswordToTheUserIfTheyHavAnEmail = function(user, temporaryPassword, successMessage, done) {
  if (!user.email || user.email.length < 5) {
    return done({
        status: 412,
        error: "The user didnt provide a valid email."
      },
      null, {
        message: "You didnt provide an email when you registered, so we can't send you a temporary password. If you can't remember your password, you might need to contact us to ask us to reset your password."
      });
  }

  if (mail_config.mailConnection.auth.user === "") {
    return done({
        status: 500,
        error: "The mail configuration is missing a user, this server cant send email."
      },
      null, {
        message: "The server was unable to send you an email, your password has not been reset. Please report this 2823"
      });
  }

  var newpassword = temporaryPassword || makeRandomPassword();
  var smtpTransport = nodemailer.createTransport("SMTP", mail_config.mailConnection);
  var mailOptions = mail_config.suspendedUserMailOptions();
  if (user.appbrand === "phophlo") {
    mailOptions = mail_config.suspendedUserMailOptionsPhophlo();
  }
  mailOptions.to = user.email + "," + mailOptions.to;
  mailOptions.text = mailOptions.text.replace(/insert_temporary_password/g, newpassword);
  mailOptions.html = mailOptions.html.replace(/insert_temporary_password/g, newpassword);

  smtpTransport.sendMail(mailOptions, function(error, response) {
    if (error) {
      console.log(new Date() + " Mail error" + util.inspect(error));
      error = error || {};
      error.error = error.error || error.code || "Mail server failed to send an email";
      error.status = cleanErrorStatus(error.status) || 500;
      return done(error,
        null, {
          message: "The server was unable to send you an email, your password has not been reset. Please report this 2898"
        });
    }

    console.log(new Date() + " Temporary pasword sent: \n" + response.message);

    var connection = user.corpora[user.corpora.length - 1];
    // save new password to couch _users too
    corpus_management.changeUsersPassword(
      connection,
      user,
      newpassword,
      function(res) {
        console.log(new Date() + " There was success in creating changing the couchdb password: " + util.inspect(res) + "\n");
        console.log(new Date() + " this is the user after changing their couch password " + JSON.stringify(user));

        var salt = user.salt = bcrypt.genSaltSync(10);
        user.hash = bcrypt.hashSync(newpassword, salt);
        user.serverlogs.oldIncorrectPasswordAttempts = user.serverlogs.oldIncorrectPasswordAttempts || [];
        user.serverlogs.incorrectPasswordAttempts = user.serverlogs.incorrectPasswordAttempts || [];
        user.serverlogs.oldIncorrectPasswordAttempts = user.serverlogs.oldIncorrectPasswordAttempts.concat(user.serverlogs.incorrectPasswordAttempts);
        user.serverlogs.incorrectPasswordAttempts = [];

        saveUpdateUserToDatabase(user, function() {
          console.log(new Date() + " Saved new hash to the user " + user.username + " after setting it to a temp password.");
        });

        return done(null,
          null, {
            message: successMessage
          });
      },
      function(err) {
        console.log(new Date() + " There was an error in creating changing the couchdb password " + util.inspect(err) + "\n");
        err.error = err.error || "Couchdb errored when trying to save the user.";
        err.status = cleanErrorStatus(err.status) || 500;
        return done(err,
          null, {
            message: "The server was unable to change your password, your password has not been reset. Please report this 2893"
          });
      });

    smtpTransport.close();
  });
};

var undoCorpusCreation = function(user, connection, docs) {
  console.log(new Date() + " TODO need to clean up a broken corpus." + util.inspect(connection), docs);
  var email = user.email || "";
  email = email + "";
  if (!email) {
    email = "bounce@lingsync.org";
  }
  /* Something is wrong with the user's app, for now, notify the user */
  if (email && email.length > 5 && mail_config.mailConnection.auth.user !== "") {
    var smtpTransport = nodemailer.createTransport("SMTP", mail_config.mailConnection);
    var mailOptions = mail_config.newUserMailOptions();
    if (user.appbrand === "phophlo") {
      mailOptions = mail_config.newUserMailOptionsPhophlo();
    }
    mailOptions.to = email + "," + mailOptions.to;
    mailOptions.text = "There was a problem while registering your user. The server admins have been notified." + user.username;
    mailOptions.html = "There was a problem while registering your user. The server admins have been notified." + user.username;
    smtpTransport.sendMail(mailOptions, function(error, response) {
      if (error) {
        console.log(new Date() + " Mail error" + util.inspect(error));
      } else {
        console.log(new Date() + " Message sent: \n" + response.message);
        console.log(new Date() + " Sent User " + user.username + " a welcome email at " + email);
      }
      smtpTransport.close(); // shut down the connection pool
    });
  } else {
    console.log(new Date() + " Didnt email welcome to new user" + user.username + " why: emailpresent: " + email + ", valid user email: " + (email.length > 5) + ", mailconfig: " + (mail_config.mailConnection.auth.user !== ""));
  }

};

/*
 * Looks up the user by username, gets the user, confirms this is the right
 * password. Takes user details from the request and saves them into the user,
 * then calls done with (error, user, info)
 *
 * If its not the right password does some logging to find out how many times
 * they have attempted, if its too many it emails them a temp password if they
 * have given us a valid email. If this is a local or dev server config, it
 * doesn't email, or change their password.
 */
module.exports.authenticateUser = function(username, password, req, done) {
  if (!username) {
    return done({
      status: 412,
      error: 'Username was not specified. ' + username
    }, null, {
      message: 'Please supply a username.'
    });
  }

  if (!password) {
    return done({
      status: 412,
      error: 'Password was not specified. ' + password
    }, null, {
      message: 'Please supply a password.'
    });
  }


  var safeUsernameForCouchDB = Connection.validateUsername(username.trim());
  if (username !== safeUsernameForCouchDB.identifier) {
    safeUsernameForCouchDB.status = safeUsernameForCouchDB.status || 406;
    return done(safeUsernameForCouchDB, null, {
      message: 'Username or password is invalid. Maybe your username is ' + safeUsernameForCouchDB.identifier + '?'
    });
  }

  findByUsername(username, function(err, user, info) {
    if (err) {
      return done(err, null, info);
    }
    if (!user) {
      // This case is a server error, it should not happen.
      return done({
        status: 500,
      }, false, {
        message: 'Server is not responding for request. Please report this 1292'
      });
    }
    verifyPassword(password, user, function(err, passwordCorrect) {
      if (err) {
        return done(err, null, {
          message: 'Server is not responding for request. Please report this 1293'
        });
      }
      if (!passwordCorrect) {
        console.log(new Date() + ' User found, but they have entered the wrong password ' + username);
        /*
         * Log this unsucessful password attempt
         */
        user.serverlogs = user.serverlogs || {};
        user.serverlogs.incorrectPasswordAttempts = user.serverlogs.incorrectPasswordAttempts || [];
        user.serverlogs.incorrectPasswordAttempts.push(new Date());
        user.serverlogs.incorrectPasswordEmailSentCount = user.serverlogs.incorrectPasswordEmailSentCount || 0;
        var incorrectPasswordAttemptsCount = user.serverlogs.incorrectPasswordAttempts.length;
        var timeToSendAnEmailEveryXattempts = incorrectPasswordAttemptsCount >= 5;
        /* Dont reset the public user or lingllama's passwords */
        if (username === "public" || username === "lingllama") {
          timeToSendAnEmailEveryXattempts = false;
        }
        if (timeToSendAnEmailEveryXattempts) {

          console.log(new Date() + ' User ' + username + ' found, but they have entered the wrong password ' + incorrectPasswordAttemptsCount + ' times. ');
          /*
           * This emails the user, if the user has an email, if the
           * email is 'valid' TODO do better email validation. and if
           * the mail_config has a valid user. For the dev and local
           * versions of the app, this wil never be fired because the
           * mail_config doesnt have a valid user. But the production
           * config does, and it is working.
           */
          if (user.email && user.email.length > 5 && mail_config.mailConnection.auth.user !== "") {
            var newpassword = makeRandomPassword();
            var smtpTransport = nodemailer.createTransport("SMTP", mail_config.mailConnection);
            var mailOptions = mail_config.suspendedUserMailOptions();
            if (user.appbrand === "phophlo") {
              mailOptions = mail_config.suspendedUserMailOptionsPhophlo();
            }
            mailOptions.to = user.email + "," + mailOptions.to;
            mailOptions.text = mailOptions.text.replace(/insert_temporary_password/g, newpassword);
            mailOptions.html = mailOptions.html.replace(/insert_temporary_password/g, newpassword);
            smtpTransport.sendMail(mailOptions, function(error, response) {
              if (error) {
                console.log(new Date() + " Mail error" + util.inspect(error));
                saveUpdateUserToDatabase(user, function() {
                  console.log(new Date() + " Server logs updated in user.");
                });
              } else {
                console.log(new Date() + " Message sent: \n" + response.message);
                user.serverlogs.incorrectPasswordEmailSentCount++;

                user.serverlogs.oldIncorrectPasswordAttempts = user.serverlogs.oldIncorrectPasswordAttempts || [];
                user.serverlogs.oldIncorrectPasswordAttempts = user.serverlogs.oldIncorrectPasswordAttempts.concat(user.serverlogs.incorrectPasswordAttempts);
                user.serverlogs.incorrectPasswordAttempts = [];

                var salt = user.salt = bcrypt.genSaltSync(10);
                user.hash = bcrypt.hashSync(newpassword, salt);
                saveUpdateUserToDatabase(user, function() {
                  console.log(new Date() + " Attempted to reset User " + user.username + " password to a temp password.");
                });
                // save new password to couch too
                corpus_management.changeUsersPassword(
                  user.corpora[user.corpora.length - 1],
                  user,
                  newpassword,
                  function(res) {
                    console.log(new Date() + " There was success in creating changing the couchdb password: " + util.inspect(res) + "\n");
                  },
                  function(err) {
                    console.log(new Date() + " There was an error in creating changing the couchdb password " + util.inspect(err) + "\n");
                  });
              }
              smtpTransport.close();
            });
            return done({
                status: 401,
                error: "Triggered an email with a temp password"
              },
              null, {
                message: 'You have tried to log in too many times. We are sending a temporary password to your email.'
              });
          } else {
            saveUpdateUserToDatabase(user,
              function() {
                console.log(new Date() + " Server logs updated in user.");
              });
            console.log(new Date() + 'User didn\'t not provide a valid email, so their temporary password was not sent by email.');
            return done({
                status: 401,
                error: "Triggered an email with a temp password"
              },
              null, {
                message: 'You have tried to log in too many times and you dont seem to have a valid email so we cant send you a temporary password.'
              });
          }

        } else {
          saveUpdateUserToDatabase(user, function() {
            console.log(new Date() + " Server logs updated in user.");
          });
          // Don't tell them its because the password is wrong.
          console.log(new Date() + " Returning: Username or password is invalid. Please try again.");

          var countDownUserToPasswordReset = "";
          if (incorrectPasswordAttemptsCount > 1) {
            countDownUserToPasswordReset = ' You have ' + (5 - incorrectPasswordAttemptsCount) + ' more attempts before a temporary password will be emailed to your registration email (if you provided one).';
          }
          return done({
              status: 401,
              error: "Invalid password"
            },
            null, {
              message: 'Username or password is invalid. Please try again.' + countDownUserToPasswordReset
            });
        }
      }
      console.log(new Date() + ' User found, and password verified ' + username);

      /*
       * Save the users' updated details, and return to caller TODO Add
       * more attributes from the req.body below
       */
      if (req.body.syncDetails === "true" || req.body.syncDetails === true) {
        console.log(new Date() + " Here is syncUserDetails: " + util.inspect(req.body.syncUserDetails));

        req.body.syncUserDetails.newCorpora = req.body.syncUserDetails.newCorpora || req.body.syncUserDetails.newCorpusConnections;
        try {
          req.body.syncUserDetails = new User(req.body.syncUserDetails);
        } catch (e) {
          console.log("Couldnt convert the users' sync details into a user.", e);
        }
        if (req.body.syncUserDetails.newCorpora) {
          console.log(new Date() + " It looks like the user has created some new local offline newCorpora. Attempting to make new corpus on the team server so the user can download them.");
          createNewCorpusesIfDontExist(user, req.body.syncUserDetails.newCorpora);
        } else {
          console.log(new Date() + " User's corpora are unchanged.");
        }
        user = new User(user);
        user.merge("self", req.body.syncUserDetails, "overwrite");
        user = user.toJSON();
        /* Users details which can come from a client side must be added here, otherwise they are not saved on sync. */
        // user.corpora = req.body.syncUserDetails.corpora;
        // user.corpora = req.body.syncUserDetails.corpora;
        // user.email = req.body.syncUserDetails.email;
        // user.gravatar = req.body.syncUserDetails.gravatar;
        // user.researchInterest = req.body.syncUserDetails.researchInterest;
        // user.affiliation = req.body.syncUserDetails.affiliation;
        // user.appVersionWhenCreated = req.body.syncUserDetails.appVersionWhenCreated;
        // user.authUrl = req.body.syncUserDetails.authUrl;
        // user.description = req.body.syncUserDetails.description;
        // user.subtitle = req.body.syncUserDetails.subtitle;
        // user.dataLists = req.body.syncUserDetails.dataLists;
        // user.prefs = req.body.syncUserDetails.prefs;
        // user.mostRecentIds = req.body.syncUserDetails.mostRecentIds;
        // user.firstname = req.body.syncUserDetails.firstname;
        // user.lastname = req.body.syncUserDetails.lastname;
        // user.sessionHistory = req.body.syncUserDetails.sessionHistory;
        // user.hotkeys = req.body.syncUserDetails.hotkeys;
      } else {
        // console.log(" Not syncing users details ", req.body);
      }

      user.updated_at = new Date();
      user.serverlogs = user.serverlogs || {};
      user.serverlogs.successfulLogins = user.serverlogs.successfulLogins || [];
      user.serverlogs.successfulLogins.push(new Date());
      if (user.serverlogs.incorrectPasswordAttempts && user.serverlogs.incorrectPasswordAttempts.length > 0) {
        user.serverlogs.oldIncorrectPasswordAttempts = user.serverlogs.oldIncorrectPasswordAttempts || [];
        user.serverlogs.oldIncorrectPasswordAttempts = user.serverlogs.oldIncorrectPasswordAttempts.concat(user.serverlogs.incorrectPasswordAttempts);
        user.serverlogs.incorrectPasswordAttempts = [];
      }
      return saveUpdateUserToDatabase(user, done);

    });

  });
};

/*
 * Ensures the requesting user to make the permissions
 * modificaitons. Then adds the role to the user if they exist
 */
module.exports.addRoleToUser = function(req, done) {
  var requestingUser = req.body.username;
  var dbConn = {};
  // If serverCode is present, request is coming from Spreadsheet app
  dbConn = req.body.connection;

  if (!dbConn || !dbConn.dbname || dbConn.dbname.indexOf("-") === -1) {
    console.log(dbConn);
    return done({
      status: 412,
      error: "Client didnt define the dbname to modify."
    }, null, {
      message: "This app has made an invalid request. Please notify its developer. missing: corpusidentifier"
    });
  }

  if (!req || !req.body.username || !req.body.username) {
    return done({
      status: 412,
      error: 'Please provide a username'
    }, null, {
      message: 'Please provide a username'
    });
  }

  if (!req || !req.body.users || req.body.users.length === 0 || !req.body.users[0].username) {
    var placeholder = {
      status: 412,
      message: "This app has made an invalid request. Please notify its developer. missing: user(s) to modify"
    };
    return done({
      status: 412,
      error: "Client didnt define the username to modify."
    }, placeholder, {
      message: placeholder.message
    });
  }

  if ((!req.body.users[0].add || req.body.users[0].add.length < 1) && (!req.body.users[0].remove || req.body.users[0].remove.length < 1)) {
    var placeholder = {
      status: 412,
      message: "This app has made an invalid request. Please notify its developer. missing: roles to add or remove"
    };
    return done({
      status: 412,
      error: "Client didnt define the roles to add nor remove"
    }, placeholder, {
      message: placeholder.message
    });
  }

  corpus.isRequestingUserAnAdminOnCorpus(req, requestingUser, dbConn, function(error, result, messages) {
    if (error) {
      return done(error, result, messages);
    }

    console.log(new Date() + " User " + requestingUser + " is admin and can modify permissions on " + dbConn.dbname);

    var sanitizeRoles = function(role) {
      if (role.indexOf("_") > -1) {
        role = role.substring(role.lastSubstring("_"));
      }
      role = dbConn.dbname + "_" + role;
      return role;
    };

    // convert roles into corpus specific roles
    req.body.users = req.body.users.map(function(userPermission) {
      if (userPermission.add && typeof userPermission.add.map === "function") {
        userPermission.add = userPermission.add.map(sanitizeRoles);
      } else {
        userPermission.add = [];
      }
      if (userPermission.remove && typeof userPermission.remove.map === "function") {
        userPermission.remove = userPermission.remove.map(sanitizeRoles);
      } else {
        userPermission.remove = [];
      }
      return userPermission;
    });


    var promises = [];

    /*
     * If they are admin, add the role to the user, then add the corpus to user if succesfull
     */

    for (var userIndex = 0; userIndex < req.body.users.length; userIndex++) {
      var sameTempPasswordForAllTheirUsers = makeRandomPassword();

      (function(userPermission) {
        var deferred = Q.defer();
        promises.push(deferred.promise);

        corpus_management.addRoleToUser(dbConn, req.body.users[userIndex], function(error, resultOfAddedToCorpusPermissions, info) {
          console.log("corpus_management.addRoleToUser ", info);
          // return done({
          //   status: 412,
          //   error: "TODO"
          // }, resultOfAddedToCorpusPermissions, {
          //   message: "TODO after addRoleToUser"
          // });

          addCorpusToUser(error, userPermission.username, dbConn, resultOfAddedToCorpusPermissions, function(error, resultOfAddedToCorpusPermissions, info) {
            console.log(" Bringing in mesages and status from successful user result.", info);
            console.log(userPermission);
            // console.log(resultOfAddedToCorpusPermissions);
            // for (var attrib in resultOfAddedToCorpusPermissions) {
            //   if (!resultOfAddedToCorpusPermissions.hasOwnProperty(attrib)) {
            //     continue;
            //   }
            //   userPermission[attrib] = resultOfAddedToCorpusPermissions[attrib];
            // }
            deferred.resolve("happy");
          });
        }, function(error, resultOfAddedToCorpusPermissions, info) {
          console.log(" Bringing in mesages and status from failing user result.", info);
          console.log(userPermission);
          // console.log(resultOfAddedToCorpusPermissions);
          // for (var attrib in resultOfAddedToCorpusPermissions) {
          //   if (!resultOfAddedToCorpusPermissions.hasOwnProperty(attrib)) {
          //     continue;
          //   }
          //   userPermission[attrib] = resultOfAddedToCorpusPermissions[attrib];
          // }
          deferred.resolve("sad");
        });

      })(req.body.users[userIndex]);
    }



    var sentDone = false;
    Q.allSettled(promises).then(function(results) {
      var userModificationResults = [];

      console.log(new Date() + " recieved promises back " + results.length);
      console.log(new Date() + " req.body.users", req.body.users);

      // results.forEach(function(result) {
      //   if (!result) {
      //     return;
      //   }
      //   if (result.state === "fulfilled") {
      //     var value = result.value;
      //     if (value.source && value.source.exception) {
      //       userModificationResults = userModificationResults + " " + value.source.exception;
      //     } else {
      //       userModificationResults = userModificationResults + " " + "Success";
      //     }
      //   } else {
      //     // not fulfilled,happens rarely
      //     var reason = result.reason;
      //     userModificationResults = userModificationResults + " " + reason;
      //   }
      // });
      req.body.users.map(function(userPermis) {
        if (userPermis.status === 200) {
          if (!sentDone) {
            sentDone = true;
            done(null, req.body.users);
          }
        }
      });
      if (!sentDone) {
        done({
          status: req.body.users[0].status,
          error: "One or more of the add roles requsts failed. " + req.body.users[0].message
        }, req.body.users);
      }

    });
    // .fail(function(error) {
    //       console.log(" returning fail.");
    //       error.status = cleanErrorStatus(error.status) || req.body.users[0].status || 500;
    //       req.body.users[0].message = req.body.users[0].message || " There was a problem processing your request. Please notify us of this error 320343";
    //       return done(error, req.body.users);
    //     });
  });
};

/*
 * Looks returns a list of users ordered by role in that corpus
 */
module.exports.fetchCorpusPermissions = function(req, done) {
  var dbConn;

  // If serverCode is present, request is coming from Spreadsheet app
  if (req.body.serverCode) {
    dbConn = Connection.defaultConnection(req.body.serverCode);
    dbConn.dbname = req.body.dbname;
  } else {
    dbConn = req.body.connection;
  }

  if (!req || !req.body.username || !req.body.username) {
    return done({
      status: 412,
      error: 'Please provide a username, you must be a member of a corpus in order to find out who else is a member.'
    }, null, {
      message: 'Please provide a username, you must be a member of a corpus in order to find out who else is a member.'
    });
  }

  if (!dbConn) {
    return done({
      status: 412,
      error: "Client didn't define the database connection."
    }, null, {
      message: "This app has made an invalid request. Please notify its developer. missing: serverCode or connection"
    });
  }

  var dbname = dbConn.dbname || dbConn.pouchname;
  var requestingUser = req.body.username;
  var requestingUserIsAMemberOfCorpusTeam = false;

  if (dbConn && dbConn.domain && dbConn.domain.indexOf("iriscouch") > -1) {
    dbConn.port = "6984";
  }
  console.log(new Date() + " " + requestingUser + " requested the team on " + dbname);
  var nanoforpermissions = require('nano')(couchConnectUrl);

  /*
   * Get user names and roles from the server
   *
   * https://127.0.0.1:6984/_users/_design/users/_view/userroles
   */
  var usersdb = nanoforpermissions.db.use("_users");
  var whichUserGroup = "normalusers";
  if (requestingUser.indexOf("test") > -1 || requestingUser.indexOf("anonymous") > -1) {
    whichUserGroup = "betatesters";
  }
  usersdb.view("users", whichUserGroup, function(error, body) {
    if (error) {
      console.log(new Date() + " Error quering userroles: " + util.inspect(error));
      console.log(new Date() + " This is the results recieved: " + util.inspect(body));
      error = error || {};
      error.status = cleanErrorStatus(error.statusCode) || 500;
      return done(error, null, {
        message: 'Server is not responding for request to query corpus permissions. Please report this 1289'
      });
    } else {
      var userroles = body.rows;
      /*
       * Get user masks from the server
       */
      var usersdb = nanoforpermissions.db.use(node_config.usersDbConnection.dbname);
      // Put the user in the database and callback
      usersdb.view("users", "usermasks", function(error, body) {
        if (error) {
          console.log(new Date() + " Error quering usermasks: " + util.inspect(error));
          console.log(new Date() + " This is the results recieved: " + util.inspect(body));
          error = error || {};
          error.status = cleanErrorStatus(error.statusCode) || 500;
          return done(error, null, {
            message: 'Server is not responding for request to quering corpus permissions. Please report this 1288'
          });
        } else {
          var usermasks = body.rows;


          /*
           Convert the array into a hash to avoid n*m behavior (instead we have n+m+h)
           */
          var usershash = {},
            userIndex,
            key,
            currentUsername,
            userIsOnTeam,
            thisUsersMask,
            rolesAndUsers = {},
            requestingUserIsAMemberOfCorpusTeam = false,
            roles,
            roleIndex,
            roleType;

          rolesAndUsers.notonteam = [];
          rolesAndUsers.allusers = [];

          // Put the user roles in
          for (userIndex = userroles.length - 1; userIndex >= 0; userIndex--) {
            if (!userroles[userIndex].key || !userroles[userIndex].value) {
              continue;
            }
            key = userroles[userIndex].key;
            usershash[key] = usershash[key] || {};
            usershash[key].roles = userroles[userIndex].value;
          }

          // Put the gravatars in for users who are in this category
          for (userIndex = usermasks.length - 1; userIndex >= 0; userIndex--) {
            if (!usermasks[userIndex].value || !usermasks[userIndex].value.username) {
              continue;
            }
            key = usermasks[userIndex].value.username;
            //if this usermask isnt in this category of users, skip them. 
            if (!usershash[key]) {
              continue;
            }
            // console.log(key, usershash[key]);
            usershash[key] = usershash[key] || {};
            usershash[key].username = usermasks[userIndex].value.username;
            usershash[key].gravatar = usermasks[userIndex].value.gravatar;
            // console.log(new Date() + "  the value of this user ", usermasks[userIndex]);

            usershash[key].gravatar_email = usermasks[userIndex].value.gravatar_email;
          }

          // Put the users into the list of roles and users
          for (currentUsername in usershash) {
            if (!usershash.hasOwnProperty(currentUsername) || !currentUsername) {
              continue;
            }
            // console.log(new Date() + " Looking at " + currentUsername);
            userIsOnTeam = false;
            thisUsersMask = usershash[currentUsername];
            if ((!thisUsersMask.gravatar || thisUsersMask.gravatar.indexOf("user_gravatar") > -1) && thisUsersMask.gravatar_email) {
              console.log(new Date() + "  the gravtar of " + currentUsername + " was missing/old ", thisUsersMask);
              thisUsersMask.gravatar = md5(thisUsersMask.gravatar_email);
            }


            // Find out if this user is a member of the team
            roles = thisUsersMask.roles;
            if (!roles) {
              console.log(new Date() + " this is odd, " + currentUsername + " doesnt have any roles defined, skipping this user, even for hte typeahead");
              continue;
            }


            // Add this user to the typeahead
            rolesAndUsers.allusers.push({
              username: currentUsername,
              gravatar: thisUsersMask.gravatar
            });
            for (roleIndex = roles.length - 1; roleIndex >= 0; roleIndex--) {

              var role = roles[roleIndex];
              if (role.indexOf(dbname + "_") === 0) {
                userIsOnTeam = true;

                // console.log(new Date() + currentUsername + " is a member of this corpus: " + role);
                if (currentUsername === requestingUser) {
                  requestingUserIsAMemberOfCorpusTeam = true;
                }

                /*
                 * If the role is for this corpus, insert the users's mask into
                 * the relevant roles, this permits the creation of new roles in the system
                 */
                roleType = role.replace(dbname + "_", "") + "s";
                rolesAndUsers[roleType] = rolesAndUsers[roleType] || [];
                rolesAndUsers[roleType].push({
                  username: currentUsername,
                  gravatar: thisUsersMask.gravatar
                });
              }
            }

            if (!userIsOnTeam) {
              rolesAndUsers.notonteam.push({
                username: currentUsername,
                gravatar: thisUsersMask.gravatar
              });
            }
          }

          /* sort alphabetically the real roles (typeaheads dont matter) */
          if (rolesAndUsers.admins) {
            rolesAndUsers.admins.sort(function(a, b) {
              if (a.username < b.username) {
                return -1;
              }
              if (a.username > b.username) {
                return 1;
              }
              return 0;
            });
          }
          if (rolesAndUsers.writers) {
            rolesAndUsers.writers.sort(function(a, b) {
              if (a.username < b.username) {
                return -1;
              }
              if (a.username > b.username) {
                return 1;
              }
              return 0;
            });
          }

          if (rolesAndUsers.readers) {
            rolesAndUsers.readers.sort(function(a, b) {
              if (a.username < b.username) {
                return -1;
              }
              if (a.username > b.username) {
                return 1;
              }
              return 0;
            });
          }
          if (rolesAndUsers.commenters) {
            rolesAndUsers.commenters.sort(function(a, b) {
              if (a.username < b.username) {
                return -1;
              }
              if (a.username > b.username) {
                return 1;
              }
              return 0;
            });
          }


          /*
           * Send the results, if the user is part of the team
           */
          if (requestingUserIsAMemberOfCorpusTeam) {
            done(null, rolesAndUsers, {
              message: "Look up successful."
            });
          } else {
            console.log("Requesting user `" + requestingUser + "` is not a member of the corpus team." + dbname);
            done({
              status: 401,
              error: "Requesting user `" + requestingUser + "` is not a member of the corpus team.",
              // team: rolesAndUsers
            }, null, {
              message: "Unauthorized, you are not a member of this corpus team."
            });
          }

        }
      });

    }
  });

};

var addCorpusToUser = function(error, username, newConnection, userPermissionResult, done) {
  if (error) {
    error = error || {};
    error.status = cleanErrorStatus(error.status) || 500;
    userPermissionResult.status = error.status;
    userPermissionResult.message = "The server is unable to respond to this request. Please report this 1289";
    return done(error, null, {
      message: userPermissionResult.message
    });
  }
  findByUsername(username, function(error, user, info) {
    console.log("Fined by username ", info);
    if (error) {
      error.status = cleanErrorStatus(error.status) || 500;
      userPermissionResult.status = error.status;
      userPermissionResult.message = 'Username doesnt exist on this server. This is a bug.';
      // Don't tell them its because the userPermissionResult doesn't exist.
      return done(error, null, {
        message: userPermissionResult.message
      });
    }
    if (!user) {
      // This case is a server error, it should not happen.
      userPermissionResult.status = error.status;
      userPermissionResult.message = 'Server was unable to process you request. Please report this: 1292';
      return done({
        status: 500,
        error: "There was no error from couch, but also no user."
      }, false, {
        message: userPermissionResult.message
      });
    }

    var shouldEmailWelcomeToCorpusToUser = false;
    user.serverlogs = user.serverlogs || {};
    user.serverlogs.welcomeToCorpusEmails = user.serverlogs.welcomeToCorpusEmails || {};
    if (userPermissionResult.after.length > 0 && !user.serverlogs.welcomeToCorpusEmails[newConnection.dbname]) {
      shouldEmailWelcomeToCorpusToUser = true;
      user.serverlogs.welcomeToCorpusEmails[newConnection.dbname] = [Date.now()];
    }

    /*
     * If corpus is already there
     */
    console.log(new Date() + " Here are the user's known corpora" + util.inspect(user.corpora));
    var alreadyAdded;
    for (var connectionIndex = user.corpora.length - 1; connectionIndex >= 0; connectionIndex--) {

      if (userPermissionResult.after.length === 0) {
        // removes from all servers, TODO this might be something we should ask the user about. 
        if (user.corpora[connectionIndex].dbname === newConnection.dbname) {
          user.corpora.splice(connectionIndex, 1);
        }
      } else {
        if (alreadyAdded) {
          continue;
        }
        if (user.corpora[connectionIndex].dbname === newConnection.dbname) {
          alreadyAdded = true;
        }
      }

    }

    var indexOfNewCorpusInExistingCorpuses = _.pluck(user.corpora, "dbname").indexOf(newConnection.dbname);
    if (userPermissionResult.after.length > 0) {
      if (alreadyAdded) {
        userPermissionResult.status = 200;
        userPermissionResult.message = 'User ' + user.username + ' now has ' +
          userPermissionResult.after.join(" ") + " access to " +
          newConnection.dbname + ', the user was already a member of this corpus team.';
        return done(
          null, userPermissionResult, {
            message: userPermissionResult.message
          });
      } else {
        /*
         * Add the new db connection to the user, save them and send them an
         * email telling them they they have access
         */
        user.corpora = user.corpora || [];
        user.corpora.unshift(newConnection);
      }
    } else {
      if (indexOfNewCorpusInExistingCorpuses > -1) {
        user.corpora.splice(indexOfNewCorpusInExistingCorpuses, 1);
      }
    }

    // return done({
    //   error: "todo",
    //   status: 412
    // }, [userPermissionResult, user.corpora], {
    //   message: "TODO. save modifying the list of corpora in the user "
    // });


    var doneAddingCorpusToUser = done;
    saveUpdateUserToDatabase(user, function(error, user, info) {
      if (error) {
        console.log("error saving user ", error, info);
        error.status = cleanErrorStatus(error.status) || 505;
        userPermissionResult.status = error.status;
        userPermissionResult.message = 'User ' + user.username + ' now has ' +
          userPermissionResult.after.join(" ") + " access to " +
          newConnection.dbname + ", but we weren't able to add this corpus to their account. This is most likely a bug, please report it.";
        return doneAddingCorpusToUser(
          error,
          userPermissionResult, {
            message: userPermissionResult.message
          });
      }

      // If the user was removed we can exit now
      if (userPermissionResult.after.length === 0) {
        userPermissionResult.status = 200;
        userPermissionResult.message = "User " + user.username + " was removed from the " +
          newConnection.dbname +
          " team.";
        return doneAddingCorpusToUser(
          null,
          userPermissionResult, {
            message: userPermissionResult.message
          });
      }

      userPermissionResult.status = 200;
      userPermissionResult.message = 'User ' + user.username + ' now has ' +
        userPermissionResult.after.join(" ") + " access to " +
        newConnection.dbname;
      // send the user an email to welcome to this corpus team
      if (shouldEmailWelcomeToCorpusToUser && user.email && user.email.length > 5 && mail_config.mailConnection.auth.user !== "") {
        var smtpTransport = nodemailer.createTransport("SMTP", mail_config.mailConnection);
        var mailOptions = mail_config.welcomeToCorpusTeamMailOptions();
        if (user.appbrand === "phophlo") {
          mailOptions = mail_config.welcomeToCorpusTeamMailOptionsPhophlo();
        }
        mailOptions.to = user.email + "," + mailOptions.to;
        mailOptions.text = mailOptions.text.replace(/insert_corpus_identifier/g, newConnection.dbname);
        mailOptions.html = mailOptions.html.replace(/insert_corpus_identifier/g, newConnection.dbname);
        smtpTransport.sendMail(mailOptions, function(error, response) {
          if (error) {
            console.log(new Date() + " Mail error" + util.inspect(error));
          } else {

            console.log(new Date() + " Message sent: \n" + response.message);
            console.log(new Date() + " Sent User " + user.username + " a welcome to corpus email at " + user.email);
          }
          smtpTransport.close();

          doneAddingCorpusToUser(
            null,
            userPermissionResult, {
              message: userPermissionResult.message
            });
        });

      } else {
        console.log(new Date() + " Didn't email welcome to corpus to new user " +
          user.username + " why: emailpresent: " + user.email +
          ", mailconfig: " + (mail_config.mailConnection.auth.user !== ""));


        return doneAddingCorpusToUser(
          null,
          userPermissionResult, {
            message: userPermissionResult.message
          });
      }

    });

  });

};
var createNewCorpusesIfDontExist = function(user, corpora) {
  if (!corpora || corpora.length === 0) {
    return;
  }
  var requestedDBCreation = {};
  console.log(new Date() + " Ensuring newCorpora are ready", corpora);
  /*
   * Creates the user's new corpus databases
   */
  corpora.map(function(potentialnewcorpusconnection) {
    if (!potentialnewcorpusconnection || !potentialnewcorpusconnection.dbname || requestedDBCreation[potentialnewcorpusconnection.dbname]) {
      console.log("Not creating this corpus ", potentialnewcorpusconnection);
      return;
    }
    if (potentialnewcorpusconnection.dbname.indexOf(user.username + "-") !== 0) {
      console.log("Not creating a corpus which appears to belong ot another user.", potentialnewcorpusconnection);
      return;
    }
    requestedDBCreation[potentialnewcorpusconnection.dbname] = true;
    corpus.createNewCorpus({
        username: user.username,
        title: potentialnewcorpusconnection.title,
        connection: potentialnewcorpusconnection
      },
      function(err, corpusDetails, info) {
        console.log("Create new corpus results", err, corpusDetails, info);
        // if (err.status === 302) {
        //   for (var connectionIndex = corpora.length - 1; connectionIndex >= 0; connectionIndex--) {
        //     if (info.message === "Your corpus " + corpora[connectionIndex].dbname + " already exists, no need to create it.") {
        //       console.log("Removing this from the new connections  has no effect." + info.message);
        //       corpora.splice(connectionIndex, 1);
        //     }
        //   }
        // }
      });
  });

};
/**
 * This function takes a user and a function. The done function is called back
 * with (error, user, info) where error contains the server's detailed error
 * (not to be shared with the client), and info contains a client readible error
 * message.
 *
 * @param user
 * @param done
 */
var sampleUsers = ["public"];
for (var userType in node_config.sampleUsers) {
  if (node_config.sampleUsers.hasOwnProperty(userType) && node_config.sampleUsers[userType].length > 0) {
    sampleUsers = sampleUsers.concat(node_config.sampleUsers[userType]);
  }
}
console.log(new Date() + "  Sample users will not recieve save preferences changes.", sampleUsers);
var saveUpdateUserToDatabase = function(user, done) {
  if (sampleUsers.indexOf(user.username) > -1) {
    return done(null, user, {
      message: "User is a reserved user and cannot be updated in this manner."
    });
  }

  // Preparing the couch connection
  var usersdb = nano.db.use(node_config.usersDbConnection.dbname);
  // Put the user in the database and callback
  usersdb.insert(user, user.username, function(error, resultuser) {
    if (error) {
      error = error || {};
      error.status = cleanErrorStatus(error.statusCode) || 500;
      console.log(new Date() + " Error saving a user: " + util.inspect(error));
      console.log(new Date() + " This is the user who was not saved: " + JSON.stringify(user));
      return done(error, null, {
        message: 'Error saving a user in the database. '
      });
    } else {
      if (resultuser.ok) {
        console.log(new Date() + " No error saving a user: " + util.inspect(resultuser));
        user._rev = resultuser.rev;
        return done(null, user, {
          message: "User details saved."
        });
      } else {
        console.log(new Date() + " No error creating a user, but response was not okay: " + util.inspect(resultuser));
        return done(resultuser, null, {
          message: 'Unknown server result, this might be a bug.'
        });
      }
    }
  });
};

/**
 * This function connects to the usersdb, tries to retrieve the doc with the
 * provided id, returns the call of the done with (error, user, info)
 *
 * @param id
 * @param done
 */

var findById = function(id, done) {
  var usersdb = nano.db.use(node_config.usersDbConnection.dbname);
  usersdb.get(id, function(error, result) {
    if (error) {
      if (error.error === "not_found") {
        console.log(new Date() + ' No User found: ' + id);
        error = error || {};
        error.status = cleanErrorStatus(error.statusCode) || 401;
        return done({
          status: 401,
          error: 'User ' + id + ' does not exist'
        }, null, {
          message: 'Username or password is invalid. Please try again.'
        });
      } else {
        console.log(new Date() + ' Error looking up the user: ' + id + '\n' + util.inspect(error));
        error = error || {};
        error.status = cleanErrorStatus(error.statusCode) || 500;
        return done(error, null, {
          message: 'Server is not responding to request. Please report this error 8913.'
        });
      }
    } else {
      if (result) {
        console.log(new Date() + ' User ' + id + ' found: \n' + result._id);

        if (result.serverlogs && result.serverlogs.disabled) {
          return done({
            status: 401,
            error: 'User ' + id + ' has been disabled, probably because of a violation of the terms of service. ' + result.serverlogs.disabled
          }, null, {
            message: 'This username has been disabled. Please contact us at support@lingsync.org if you would like to reactivate this username. Reasons: ' + result.serverlogs.disabled
          });
        }

        result.corpora = result.corpora || result.corpuses || [];
        if (backwardCompatible) {
          result.corpuses = result.corpora;
        } else {
          console.log(" Upgrading " + result.username + " data structure to v3.0");
          delete result.corpuses;
        }

        return done(null, result, null);
      } else {
        console.log(new Date() + ' No User found: ' + id);
        return done({
          status: 401,
          error: 'User ' + id + ' does not exist'
        }, null, {
          message: 'Username or password is invalid. Please try again.'
        });
      }
    }
  });
};

/**
 * This function uses findById since we have decided to save usernames as id's
 * in the couchdb
 */
var findByUsername = function(username, done) {
  return findById(username, done);
};

/**
 * This function uses tries to look up users by email
 */
var findByEmail = function(email, optionallyRestrictToIncorrectLoginAttempts, done) {

  var usersQuery = "usersByEmail";
  if (optionallyRestrictToIncorrectLoginAttempts) {
    usersQuery = "userWhoHaveTroubleLoggingIn";
  }
  usersQuery = usersQuery + '?key="' + email + '"';
  var usersdb = nano.db.use(node_config.usersDbConnection.dbname);
  // Query the database and callback with matching users
  usersdb.view("users", usersQuery, function(error, body) {
    if (error) {
      console.log(new Date() + " Error quering " + usersQuery + " " + util.inspect(error));
      console.log(new Date() + " This is the results recieved: " + util.inspect(body));
      error = error || {};
      error.status = cleanErrorStatus(error.statusCode) || 500;
      return done(error, null, {
        message: 'Server is not responding to request. Please report this 1609'
      });
    } else {
      console.log(new Date() + " " + usersQuery + " requested users who have this email " + email + " from the server, and recieved results ");
      var users = body.rows.map(function(row) {
        return row.value;
      });

      console.log(new Date() + " users " + util.inspect(users));
      var userFriendlyExplaination = "Found " + users.length + " users for " + optionallyRestrictToIncorrectLoginAttempts;
      if (users.length === 0) {
        userFriendlyExplaination = "Sorry, there are no users who have failed to login who have the email you provided " + email + ". You cannot request a temporary password until you have at least tried to login once with your correct username. If you are not able to guess your username please contact us for assistance.";
        return done({
            status: 401,
            error: "No matching users for " + optionallyRestrictToIncorrectLoginAttempts
          },
          users, {
            message: userFriendlyExplaination
          });
      }
      return done(null,
        users, {
          message: userFriendlyExplaination
        });
    }

  });

};



/**
 * This function accepts an old and new password, a user and a function to be
 * called with (error, user, info)
 *
 *
 * @param oldpassword
 * @param newpassword
 * @param username
 * @param done
 */
var setPassword = function(oldpassword, newpassword, username, done) {

  if (!username) {
    return done({
      status: 412,
      error: 'Please provide a username'
    }, null, {
      message: 'Please provide a username'
    });
  }

  if (!oldpassword) {
    return done({
      status: 412,
      error: 'Please provide your old password'
    }, null, {
      message: 'Please provide your old password'
    });
  }

  if (!newpassword) {
    return done({
      status: 412,
      error: 'Please provide your new password'
    }, null, {
      message: 'Please provide your new password'
    });
  }

  var safeUsernameForCouchDB = Connection.validateUsername(username);
  if (username !== safeUsernameForCouchDB.identifier) {
    var error = {
      status: 412
    };
    return done(error, null, {
      message: 'Username or password is invalid. Please try again.'
    });
  }

  findByUsername(username, function(error, user, info) {
    if (error) {
      // console.log(new Date() + " Error looking up user  " + username + " : " + util.inspect(error));
      return done(error, null, info);
    }

    if (!user) {
      console.log(new Date() + " User " + username + " does not exist on this server " + util.inspect(user));
      return done({
        error: " User " + username + " does not exist on this server "
      }, null, info);
    }


    console.log(new Date() + " Found user in setPassword: " + util.inspect(user));

    bcrypt.compare(oldpassword, user.hash, function(err, passwordCorrect) {
      if (err) {
        return done(err, null, {
          message: 'Username or password is invalid. Please try again.'
        });
      }
      if (!passwordCorrect) {
        return done({
          error: "User entered an invalid passsword."
        }, null, {
          message: 'Username or password is invalid. Please try again.'
        });
      }
      if (passwordCorrect) {
        var salt = user.salt = bcrypt.genSaltSync(10);
        user.hash = bcrypt.hashSync(newpassword, salt);
        console.log(salt, user.hash);
        // Save new password to couch too
        corpus_management.changeUsersPassword(user.corpora[user.corpora.length - 1], user, newpassword,
          function(res) {
            console
              .log(new Date() + " There was success in creating changing the couchdb password: " + util.inspect(res) + "\n");
          },
          function(err) {
            console
              .log(new Date() + " There was an error in creating changing the couchdb password " + util.inspect(err) + "\n");
          });

        // Save user to database and change the success message to be more appropriate
        saveUpdateUserToDatabase(user, function(err, user, info) {
          if (info.message === "User details saved.") {
            info.message = "Your password has succesfully been updated.";
          }
          return done(err, user, info);
        });

      }
    });

  });

};
module.exports.setPassword = setPassword;



/**
 * This function accepts an email, finds associated users who have had incorrect login
 * attempts, and a function to be
 * called with (error, user, info)
 *
 *
 * @param email
 * @param done
 */
var forgotPassword = function(email, done) {

  if (!email) {
    return done({
      status: 412,
      error: 'Please provide an email.'
    }, null, {
      message: 'Please provide an email.'
    });
  }


  findByEmail(email, "onlyUsersWithIncorrectLogins", function(error, users, info) {
    if (error) {
      // console.log(new Date() + " Error looking up user  " + username + " : " + util.inspect(error));
      error.status = cleanErrorStatus(error.status) || 500;
      return done(error, null, info);
    }

    if (!users) {
      console.log(new Date() + " User " + email + " does not exist on this server " + util.inspect(email));
      return done({
        error: " User " + email + " does not exist on this server "
      }, null, info);
    }

    var promises = [];
    var resultDetails = [];

    for (var userIndex = 0; userIndex < users.length; userIndex++) {
      var sameTempPasswordForAllTheirUsers = makeRandomPassword();

      (function(user) {
        var deferred = Q.defer();
        promises.push(deferred.promise);
        /* debugging promises section
        process.nextTick(function() {

          console.log(new Date() + " sending happy");
          resultDetails.push({
            error: {
              status: 401
            },
            info: {
              "message": "positive place holder"
            }
          });
          deferred.resolve("whatever we put here we cant get out");

          // console.log(new Date() + " sending sad");
          // resultDetails.push({
          //   error: {
          //     status: 500,
          //     error: "server died while trying to email you. "
          //   },
          //   info: {
          //     "message": "server died while emailing you. "
          //   }
          // });

          // resultDetails.push({
          //   error: {
          //     status: 412,
          //     error: "you dont hvae an email. "
          //   },
          //   info: {
          //     "message": "you dont have an email. "
          //   }
          // });
          deferred.reject("whatever we put here we cant get out");

          // throw "simulate internal error"
        });
       */
        emailTemporaryPasswordToTheUserIfTheyHavAnEmail(user, sameTempPasswordForAllTheirUsers, "A temporary password has been sent to your email " + email, function(error, shouldbenouser, info) {
          resultDetails.push({
            error: error,
            info: info
          });
          console.log(new Date() + " finished emailTemporaryPasswordToTheUserIfTheyHavAnEmail requested by " + email + " " + util.inspect(error) + " info " + util.inspect(error));
          if (error) {
            deferred.reject("whatever we put here, we cant get out");
          } else {
            deferred.resolve("whatever we put here, we cant get out");
          }
        });
      })(users[userIndex]);

    }
    console.log(new Date() + "  requested " + promises.length + " user's password to be reset since they are associated with " + email + " ");

    var passwordChangeResults = "";
    var finalForgotPasswordResult = {
      status_codes: "",
      error: {
        status: 200,
        error: ""
      },
      info: {
        message: ""
      }
    };
    Q.allSettled(promises).then(function(results) {
      console.log(new Date() + " recieved promises back " + results.length);
      results.forEach(function(result) {
        if (!result) {
          return;
        }
        if (result.state === "fulfilled") {
          var value = result.value;
          if (value.source && value.source.exception) {
            passwordChangeResults = passwordChangeResults + " " + value.source.exception;
          } else {
            passwordChangeResults = passwordChangeResults + " " + "Success";
          }
        } else {
          // not fulfilled,happens rarely
          var reason = result.reason;
          passwordChangeResults = passwordChangeResults + " " + reason;
        }
      });
      console.log(new Date() + " passwordChangeResults " + passwordChangeResults);


      resultDetails.map(function(result) {
        if (result.error) {
          finalForgotPasswordResult.status_codes = finalForgotPasswordResult.status_codes + " " + result.error.status;
          if (result.error.status > finalForgotPasswordResult.error.status) {
            finalForgotPasswordResult.error.status = result.error.status;
          }
          finalForgotPasswordResult.error.error = finalForgotPasswordResult.error.error + " " + result.error.error;
        }
        finalForgotPasswordResult.info.message = finalForgotPasswordResult.info.message + " " + result.info.message;
      });

      if (passwordChangeResults.indexOf('Success') > -1) {
        // At least one email was sent, this will be considered a success since the user just needs one of the emails to login to his/her username(s)
        return done(null, finalForgotPasswordResult, finalForgotPasswordResult.info);
      } else {
        finalForgotPasswordResult.status_codes = finalForgotPasswordResult.status_codes;
        return done(finalForgotPasswordResult.error, finalForgotPasswordResult, finalForgotPasswordResult.info);
      }

    }).fail(function(error) {
      return done(error, resultDetails, {
        message: "The server was unable to process your request. Please report this 2198."
      });
    });

  });

};
module.exports.forgotPassword = forgotPassword;

/**
 * This function generates a temporary password which is alpha-numeric and 10
 * chars long
 *
 * @returns {String}
 */

var makeRandomPassword = function() {
  var text = "";
  var possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (var i = 0; i < 10; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
};

var verifyPassword = function(password, user, done) {
  /*
   * If the user didnt furnish a password, set a fake one. It will return
   * unauthorized.
   */
  if (!password) {
    password = " ";
  }
  bcrypt.compare(password, user.hash, done);
};
