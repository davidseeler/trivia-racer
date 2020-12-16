// Setup
var express = require('express');
var get = require('http').get;
var app = express();
var serv = require('http').Server(app);
var io = require('socket.io')(serv, {});
var node_fetch = require('node-fetch');
// Express endpoint setup
app.get('/', function (req, res) {
    res.sendFile(__dirname + '/client/index.html');
});
app.use('/client', express.static(__dirname + '/client'));
// Start listening for connections
serv.listen(process.env.PORT || 2000);
console.log("Server started.");
// Global variables
var SOCKET_LIST = {};
var activeGames = {};
var lobbies = {};
var hosts = {};
var namesList = [];
/*----------------Socket communication--------------*/
io.sockets.on('connection', function (socket) {
    // Create a new user entity on new connection
    socket.id = Math.random();
    socket.username = generateName();
    SOCKET_LIST[socket.id] = socket;
    // Inform client
    socket.emit("playerInfo", socket.username);
    // Update connecting users with current game state
    socket.emit("fetchExistingLobbies", lobbies);
    // Broadcast new connection in the chat
    broadcast({
        type: "addToChat",
        msg: "" + socket.username + " connected.",
        system: true
    });
    // Update client-side player count
    broadcast({
        type: "updatePlayerCount",
        count: Object.keys(SOCKET_LIST).length
    });
    // On player disconnnection
    socket.on('disconnect', function () {
        deletePlayerData(socket.username);
        delete SOCKET_LIST[socket.id];
        // Broadcast the disconnection in the chat
        broadcast({
            type: "addToChat",
            msg: "" + socket.username + " disconnected.",
            system: true
        });
        // Update client-side player count
        broadcast({
            type: "updatePlayerCount",
            count: Object.keys(SOCKET_LIST).length
        });
    });
    // Broadcast messages posted in chatroom
    socket.on("sendMsg", function (data) {
        broadcast({
            type: "addToChat",
            msg: "" + socket.username + ": " + data,
            system: false
        });
    });
    // Handles username change request
    socket.on("updateName", function (desiredName) {
        // Check if name isn't already taken
        if (!namesList.includes(desiredName)) {
            var isHost = false;
            var partyID = "";
            var originalName = socket.username;
            // Set the new name
            socket.username = desiredName;
            namesList[namesList.indexOf(originalName)] = desiredName;
            // Check if player is in a lobby
            for (var lobby in lobbies) {
                if (lobbies[lobby]['players'].includes(originalName)) {
                    isHost = false;
                    partyID = lobby;
                    var playerIndex = lobbies[lobby]['players'].indexOf(originalName);
                    lobbies[lobby]['players'][lobbies[lobby]['players'].indexOf(originalName)] = desiredName;
                    // Check if host
                    if (playerIndex == 0) {
                        isHost = true;
                        hosts[desiredName] = hosts[originalName];
                        delete hosts[originalName];
                    }
                }
            }
            // Brodcast the name change to chat
            broadcast({
                type: "addToChat",
                oldName: originalName,
                newName: socket.username,
                isHost: isHost,
                lobbyID: partyID,
                nameChange: true,
                msg: "" + originalName + " now goes by '" + socket.username + "'.",
                system: true
            });
        }
        // Desired name is unavailable
        else {
            socket.emit("unavailableName", desiredName);
        }
    });
    // Handle player leaving the game
    socket.on("quit", function () {
        deletePlayerData(socket.username);
    });
    // Handle new lobby creation request
    socket.on("createLobby", function () {
        removeIfInLobby(socket.username);
        // Create new entry in lobbies dictionary
        lobbies[Object.keys(lobbies).length] = {
            players: [socket.username],
            category: '9'
        };
        // Broadcast created lobby
        broadcast({
            type: "createLobby",
            lobbyID: Object.keys(lobbies).length - 1,
            name: socket.username,
            size: 1,
            category: lobbies[Object.keys(lobbies).length - 1]['category']
        });
        // Add creator to hosts
        hosts[socket.username] = Object.keys(lobbies).length - 1;
    });
    // Handle player joining a lobby
    socket.on("joinLobby", function (data) {
        // Check target lobby current capacity
        var sizeOfLobby = lobbies[data.lobbyID]['players'].length;
        if (sizeOfLobby < 4) {
            // Check if the player is a host or already in another lobby
            dissolveHostLobby(data.name);
            removeIfInLobby(data.name);
            // Add player to target lobby
            lobbies[data.lobbyID]['players'][sizeOfLobby] = data.name;
            sizeOfLobby++;
            // Broadcast the hop to all other players
            broadcast({
                type: "updateLobbies",
                lobbyID: data.lobbyID,
                size: sizeOfLobby
            });
            // Lock the lobby if it is full
            if (sizeOfLobby == 4) {
                broadcast({
                    type: "lobbyFull",
                    lobbyID: data.lobbyID
                });
            }
        }
    });
    // Handle host changing lobby category
    socket.on("changeCategory", function (data) {
        lobbies[data.lobbyID]['category'] = data.category;
        // Update clients
        broadcast({
            type: "changeCategory",
            lobbyID: data.lobbyID,
            category: data.category
        });
    });
    // Game setup
    socket.on("startGame", function (data) {
        var lobbyID = hosts[data];
        // Move players to a party
        var party = [];
        for (var i = 0; i < 4; i++) {
            if (lobbies[lobbyID]['players'][i] == null) {
                party[i] = "Empty";
            }
            else {
                party[i] = lobbies[lobbyID]['players'][i];
            }
        }
        // Create active game session
        createGameSession(lobbyID, party);
        // Prepare questions and start game
        var category = "category=" + lobbies[lobbyID]['category'];
        var wait = getData(category);
        wait.then(function (result) {
            activeGames[lobbyID]['questions'] = result;
            broadcast({
                type: "startGame",
                lobbyID: hosts[data],
                party: party
            });
            shuffleAnswers(lobbyID);
        });
        // Delete lobby
        readyUpEmpties(lobbyID);
        dissolveHostLobby(data);
    });
    // Handle player ready up at the ready up window
    socket.on("initialReadyUp", function () {
        var gameID = getGameID(socket.username);
        // Mark player is ready
        activeGames[gameID]['ready'].push(socket.username);
        // Update party members
        partyMessage({
            type: "playerReady",
            player: activeGames[gameID]['players'].indexOf(socket.username)
        }, gameID);
        // When all players are ready, set the game stage
        if (activeGames[gameID]['ready'].length == 4) {
            partyMessage({
                type: "setGameStage"
            }, gameID);
        }
    });
    // Handles host changing the score cap
    socket.on("scoreToWinChange", function (data) {
        var gameID = getGameID(data[0]);
        activeGames[gameID]['scoreToWin'] = data[1];
        // Update party members
        partyMessage({
            type: "scoreToWinChange",
            value: data[1]
        }, gameID);
    });
    // Handles a player changing their car color
    socket.on("changeColor", function (data) {
        var gameID = getGameID(socket.username);
        // Update party members
        partyMessage({
            type: "colorChange",
            car: data[0],
            color: data[1]
        }, gameID);
    });
    // Start the game
    socket.on("playGame", function () {
        var gameID = getGameID(socket.username);
        resetReadyPlayers(gameID);
        // Host sends first question
        if (socket.username == activeGames[gameID]['players'][0]) {
            // Broadcast question to party
            partyMessage({
                type: "displayQuestion",
                question: activeGames[gameID]['questions']['results'][0],
                time: 3
            }, gameID);
            // "unready" the players and wait for 4 more ready confirmations
            resetReadyPlayers(gameID);
            setEmptiesAnswer(gameID);
        }
    });
    // Handle player answering question
    socket.on("playerAnswer", function (data) {
        try {
            var gameID = getGameID(socket.username);
            // Ready up player
            activeGames[gameID]['ready'].push(socket.username);
            if (socket.username == activeGames[gameID]['ready'][3]) {
                partyMessage({
                    type: "allPlayersAnswered"
                }, gameID);
            }
            // Broadcast to party that the player is ready
            partyMessage({
                type: "playerAnswer",
                playerIndex: activeGames[gameID]['players'].indexOf(socket.username)
            }, gameID);
            // 9 resembles unanswered question
            if (data != 9) {
                // Check if correct answer
                var round = activeGames[gameID]['round'];
                var correctAnswer = activeGames[gameID]['questions']['results'][round]['correct_answer'];
                var response = activeGames[gameID]['questions']['results'][round]['shuffledAnswers'][data];
                // Increment player's score if answered correctly
                if (response == correctAnswer) {
                    activeGames[gameID]['score'][getPlayerScoreIndex(socket.username)][1]++;
                }
            }
        }
        catch (e) {
            console.error(e);
        }
    });
    // Check the answers at the end of a round
    socket.on("checkAnswers", function () {
        try {
            var gameID = getGameID(socket.username);
            var round = activeGames[gameID]['round'];
            // Host sends a score update (which moves the cars)
            if (socket.username == activeGames[gameID]['players'][0]) {
                partyMessage({
                    type: "movePlayers",
                    score: activeGames[gameID]['score'],
                    correct: activeGames[gameID]['questions']['results'][round]['correct_answer'],
                    scoreToWin: activeGames[gameID]['scoreToWin']
                }, gameID);
                activeGames[gameID]['round']++;
            }
        }
        catch (e) {
            console.error(e);
        }
    });
    // Send next question at end of round and clients are synced up
    socket.on("nextQuestion", function () {
        concludeRound(getGameID(socket.username));
    });
});
/*----------------Utility Functions-------------*/
// Sync up all players, move players, send next question
function concludeRound(gameID) {
    try {
        var round = activeGames[gameID]['round'];
        var winner = checkForWinner(gameID);
        // Check for winner or round limit reached
        if (winner[0] || round == 49) {
            // Broadcast game over and delete game session
            partyMessage({
                type: "gameover",
                winner: winner[1],
                score: activeGames[gameID]['score'],
                numberOfRounds: round
            }, gameID);
            delete activeGames[gameID];
        }
        // Continue/Start playing
        else if (round != 49) {
            if (activeGames[gameID]['ready'].length == 4) {
                // Broadcast question to party
                partyMessage({
                    type: "displayQuestion",
                    question: activeGames[gameID]['questions']['results'][round],
                    time: 10
                }, gameID);
                // "unready" the players and wait for 4 more ready confirmations
                resetReadyPlayers(gameID);
                setEmptiesAnswer(gameID);
            }
        }
    }
    catch (e) {
        console.error(e);
    }
}
// Message to be sent to all clients
function broadcast(msg) {
    for (var i in SOCKET_LIST) {
        var socket = SOCKET_LIST[i];
        socket.emit("broadcast", msg);
    }
}
// Message to be sent to players in specified party
function partyMessage(msg, gameID) {
    for (var socket in activeGames[gameID]['sockets']) {
        if (activeGames[gameID]['sockets'][socket] != "Empty") {
            activeGames[gameID]['sockets'][socket].emit("partyMessage", msg);
        }
    }
}
// Generates random unique username
function generateName() {
    var username = "Player" + Math.floor(Math.random() * 1000);
    while (namesList.includes(username)) {
        username = "Player" + Math.floor(Math.random() * 1000);
    }
    namesList.push(username);
    return username;
}
// Remove disconnected player's data
function deletePlayerData(username) {
    // Remove if in lobby
    for (var lobby in lobbies) {
        if (lobbies[lobby]['players'].includes(username)) {
            delete lobbies[lobby];
            broadcast({
                type: "disconnection",
                lobbyID: lobby
            });
            break;
        }
    }
    // Remove if in game
    for (var game in activeGames) {
        if (activeGames[game]['players'].includes(username)) {
            partyMessage({
                type: "disconnection",
                disconnected: username
            }, game);
            delete activeGames[game];
            break;
        }
    }
    // Remove from hosts
    if (hosts[username] != null) {
        delete hosts[username];
    }
    // Remove from names list
    if (namesList.indexOf(username) != null) {
        namesList.splice(namesList.indexOf(username), 1);
    }
}
// Check if player is a host and remove lobby
function dissolveHostLobby(username) {
    if (hosts[username] != null) {
        broadcast({
            type: "deleteLobby",
            name: username,
            lobbyID: hosts[username]
        });
        delete lobbies[hosts[username]];
        delete hosts[username];
    }
}
// Check and remove if player is already in a lobby
function removeIfInLobby(username) {
    for (var lobby in lobbies) {
        if ((lobbies[lobby]['players']).includes(username)) {
            for (var i = 0; i < (lobbies[lobby]['players']).length; i++) {
                if ((lobbies[lobby]['players'][i]) == username) {
                    lobbies[lobby]['players'] = decrementLobby(lobbies[lobby]['players'], i);
                    broadcast({
                        type: "playerHop",
                        lobbyID: lobby,
                        size: lobbies[lobby]['players'].length,
                        host: getHostOfLobby(lobby)
                    });
                }
            }
        }
    }
}
// Adjust lobby array on decrement
function decrementLobby(lobby, indexToRemove) {
    // Size 2
    if (lobby.length == 2) {
        lobby = [lobby[0]];
    }
    // Size 3
    else if (lobby.length == 3) {
        if (indexToRemove == 1) {
            lobby = [lobby[0], lobby[2]];
        }
        if (indexToRemove == 2) {
            lobby = [lobby[0], lobby[1]];
        }
    }
    // Size 4
    else if (lobby.length == 4) {
        if (indexToRemove == 1) {
            lobby = [lobby[0], lobby[2], lobby[3]];
        }
        else if (indexToRemove == 2) {
            lobby = [lobby[0], lobby[1], lobby[3]];
        }
        else if (indexToRemove == 3) {
            lobby = [lobby[0], lobby[1], lobby[2]];
        }
    }
    return lobby;
}
// Call Open Trivia Database API to retrieve question data
function getData(category) {
    return node_fetch("https://opentdb.com/api.php?amount=50&" + category + "&type=multiple")
        .then(function (res) { return res.json(); });
}
// Return host of specificed lobby
function getHostOfLobby(lobby) {
    for (var host in hosts) {
        if (hosts[host] == lobby) {
            return host;
        }
    }
}
// Find and return ID of game that calling client is in
function getGameID(username) {
    for (var game in activeGames) {
        if (activeGames[game]['players'].includes(username)) {
            return game;
        }
    }
}
// Create a new active game session
function createGameSession(lobbyID, party) {
    activeGames[lobbyID] = {};
    activeGames[lobbyID]['players'] = party;
    activeGames[lobbyID]['sockets'] = getPlayerSockets(party);
    activeGames[lobbyID]['ready'] = [];
    activeGames[lobbyID]['round'] = 0;
    activeGames[lobbyID]['questions'] = {};
    activeGames[lobbyID]['score'] = [];
    activeGames[lobbyID]['scoreToWin'] = 5;
    createScoreArrays(lobbyID);
}
// Handles empty slots in an active game session
function readyUpEmpties(gameID) {
    // Ready up empty players
    for (var i = 0; i < 4; i++) {
        if (activeGames[gameID]['players'][i] == "Empty") {
            activeGames[gameID]['ready'].push("Empty");
        }
    }
}
// "Answers" the question and sets the "ready" tag for empty players
function setEmptiesAnswer(gameID) {
    var emptyIndices = [];
    for (var i = 0; i < 4; i++) {
        if (activeGames[gameID]['players'][i] == "Empty") {
            emptyIndices.push(i);
        }
    }
    // If there are empties in the party
    if (emptyIndices.length != 0) {
        partyMessage({
            type: "playerAnswer",
            playerIndex: emptyIndices
        }, gameID);
    }
}
// Return an array containing a party's members' sockets
function getPlayerSockets(party) {
    var sockets = [];
    for (var player in party) {
        if (party[player] == "Empty") {
            sockets.push("Empty");
        }
        else {
            for (var i in SOCKET_LIST) {
                var socket = SOCKET_LIST[i];
                if (socket.username == party[player]) {
                    sockets.push(socket);
                }
            }
        }
    }
    return sockets;
}
// Shuffle answer choices for all retrieved questions
function shuffleAnswers(gameID) {
    // Iterate through each question retrieved
    for (var question in activeGames[gameID]['questions']['results']) {
        // Combine incorrect and correct answers into one array	
        var arr = activeGames[gameID]['questions']['results'][question]['incorrect_answers'];
        arr[3] = activeGames[gameID]['questions']['results'][question]['correct_answer'];
        // Shuffle
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var temp = arr[i];
            arr[i] = arr[j];
            arr[j] = temp;
        }
        activeGames[gameID]['questions']['results'][question]['shuffledAnswers'] = arr;
    }
}
// "unready up" the players in an active game session
function resetReadyPlayers(gameID) {
    delete activeGames[gameID]['ready'];
    activeGames[gameID]['ready'] = [];
    readyUpEmpties(gameID);
}
// Create matrix to store player scores
function createScoreArrays(gameID) {
    for (var i = 0; i < 4; i++) {
        activeGames[gameID]['score'][i] = [activeGames[gameID]['players'][i], 0];
    }
}
// Returns the index of the score for a player
function getPlayerScoreIndex(player) {
    var gameID = getGameID(player);
    for (var i = 0; i < 4; i++) {
        if (player == activeGames[gameID]['score'][i][0]) {
            return i;
        }
    }
}
// Checks the scoreboards for a winner
function checkForWinner(gameID) {
    for (var i = 0; i < 4; i++) {
        if (activeGames[gameID]['score'][i][1] == activeGames[gameID]['scoreToWin']) {
            return [true, activeGames[gameID]['score'][i][0]];
        }
    }
    return [false, ""];
}
