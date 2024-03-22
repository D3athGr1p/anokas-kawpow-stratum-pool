var bitcoin = require('bitcoinjs-lib');
var util = require('./util.js');
const crypto = require('crypto');

// public members
var txHash;

exports.txHash = function(){
  return txHash;
};

function scriptCompile(addrHash){
    script = bitcoin.script.compile(
        [
            bitcoin.opcodes.OP_DUP,
            bitcoin.opcodes.OP_HASH160,
            addrHash,
            bitcoin.opcodes.OP_EQUALVERIFY,
            bitcoin.opcodes.OP_CHECKSIG
        ]);
    return script;
}

function scriptFoundersCompile(address){
    script = bitcoin.script.compile(
        [
            bitcoin.opcodes.OP_HASH160,
            address,
            bitcoin.opcodes.OP_EQUAL
        ]);
    return script;
}

var blockIdentifier = '/nodeStratum/';

function getBlockIdentifier () {
    return '/' + blockIdentifier + '/';
}

var generateOutputTransactions = function (poolRecipient, recipients, rpcData) {

    var reward = rpcData.coinbasevalue;
    if (!reward) {
        reward = util.getKotoBlockSubsidy(rpcData.height);
        reward -= rpcData.coinbasetxn.fee; 
    }

    var rewardToPool = reward;

    var txOutputBuffers = [];


    // Founder
    if (rpcData.founder.payee) {
        var payeeReward = 0;

        payeeReward = rpcData.founder.amount;

        reward -= payeeReward;
        rewardToPool -= payeeReward;

        var payeeScript = scriptCompile(bitcoin.address.fromBase58Check(rpcData.founder.payee).hash)
        txOutputBuffers.push(Buffer.concat([
            util.packInt64LE(payeeReward),
            util.varIntBuffer(payeeScript.length),
            Buffer.from(payeeScript)
        ]));
    }

    // Smart node
    if (rpcData.smartnode.length > 0) {

        for (let i = 0; i < rpcData.smartnode.length; i++) {
            var payeeReward = rpcData.smartnode[i].amount;

            reward -= payeeReward;
            rewardToPool -= payeeReward;

            var payeeScript = scriptCompile(bitcoin.address.fromBase58Check(rpcData.smartnode[i].payee).hash)

            txOutputBuffers.push(Buffer.concat([
                util.packInt64LE(payeeReward),
                util.varIntBuffer(payeeScript.length),
                Buffer.from(payeeScript)
            ]));
        }
    }

    // calculate total fees
    var feePercent = 0;
    for (var i = 0; i < recipients.length; i++) {
        feePercent = feePercent + recipients[i].percent;
    }

    for (var i = 0; i < recipients.length; i++) {
        var recipientReward = Math.floor(recipients[i].percent * rewardToPool);
        
        rewardToPool -= recipientReward;
        var recipientscript = scriptCompile(bitcoin.address.fromBase58Check(recipients[i].address).hash);
        txOutputBuffers.push(Buffer.concat([
            util.packInt64LE(recipientReward),
            util.varIntBuffer(recipientscript.length),
            recipientscript
        ]));
    }

    txOutputBuffers.unshift(Buffer.concat([
        util.packInt64LE(Math.floor(rewardToPool)),
        util.varIntBuffer(poolRecipient.length),
        Buffer.from(poolRecipient)
    ]));

    // if (rpcData.default_witness_commitment !== undefined) {
    //     let witness_commitment = new Buffer(rpcData.default_witness_commitment, 'hex');
    //     txOutputBuffers.unshift(Buffer.concat([
    //         util.packInt64LE(0),
    //         util.varIntBuffer(witness_commitment.length),
    //         witness_commitment
    //     ]));
    // }

    return Buffer.concat([
        util.varIntBuffer(txOutputBuffers.length),
        Buffer.concat(txOutputBuffers)
    ]);

};

exports.createGeneration = function(rpcData, blockReward, feeReward, recipients, poolAddress){
    var _this = this;
    var blockPollingIntervalId;

    var emitLog = function (text) {
        _this.emit('log', 'debug', text);
    };
    var emitWarningLog = function (text) {
        _this.emit('log', 'warning', text);
    };
    var emitErrorLog = function (text) {
        _this.emit('log', 'error', text);
    };
    var emitSpecialLog = function (text) {
        _this.emit('log', 'special', text);
    };

    var poolAddrHash = bitcoin.address.fromBase58Check(poolAddress).hash;

    var tx = new bitcoin.Transaction();

    var txType = 0;
    var txVersion = 0;
    var txLockTime = 0;
    var txExtraPayload;
    if (rpcData.coinbase_payload && rpcData.coinbase_payload.length > 0) {
        txVersion = 3;
        txType = 5;
        txExtraPayload = new Buffer(rpcData.coinbase_payload, 'hex');
    }

    if (!(rpcData.coinbasetxn && rpcData.coinbasetxn.data)) {
        txVersion = txVersion + (txType << 16);
    }


    var txInPrevOutHash = "";
    var txInPrevOutIndex = Math.pow(2, 32) - 1;
    var txInSequence = 0;

    //Only required for POS coins
    var txTimestamp = new Buffer([]);

    //For coins that support/require transaction comments
    var txComment = new Buffer([]);

    var extraNoncePlaceholder = ''
    var scriptSigPart1 = Buffer.concat([
        util.serializeNumber(rpcData.height),
        //new Buffer(rpcData.coinbaseaux.flags, 'hex'),
        util.serializeNumber(Date.now() / 1000 | 0),
        new Buffer([extraNoncePlaceholder.length])
    ]);


    var scriptSigPart2 = util.serializeString(getBlockIdentifier());

    // for Koto transaction v3/v4 format 
    var nVersionGroupId = (txVersion & 0x7fffffff) == 3 ? util.packUInt32LE(0x2e7d970) :
        (txVersion & 0x7fffffff) == 4 ? util.packUInt32LE(0x9023e50a) : new Buffer([]);

    var txInputsCount = 1

    var p1 = Buffer.concat([
        util.packUInt32LE(txVersion),
        nVersionGroupId,
        txTimestamp,

        //transaction input
        util.varIntBuffer(txInputsCount),
        util.uint256BufferFromHash(txInPrevOutHash),
        util.packUInt32LE(txInPrevOutIndex),
        util.varIntBuffer(scriptSigPart1.length + extraNoncePlaceholder.length + scriptSigPart2.length),
        scriptSigPart1
    ]);


    /*
    The generation transaction must be split at the extranonce (which located in the transaction input
    scriptSig). Miners send us unique extranonces that we use to join the two parts in attempt to create
    a valid share and/or block.
     */

    var outputTransactions = generateOutputTransactions(scriptCompile(poolAddrHash), recipients, rpcData);

    // for Koto transaction v2/v3/v4 format
    var nExpiryHeight = (txVersion & 0x7fffffff) >= 3 ? util.packUInt32LE(0) : new Buffer([]);
    var valueBalance = (txVersion & 0x7fffffff) >= 4 ? util.packInt64LE(0) : new Buffer([]);
    var vShieldedSpend = (txVersion & 0x7fffffff) >= 4 ? new Buffer([0]) : new Buffer([]);
    var vShieldedOutput = (txVersion & 0x7fffffff) >= 4 ? new Buffer([0]) : new Buffer([]);
    var nJoinSplit = (txVersion & 0x7fffffff) >= 2 ? new Buffer([0]) : new Buffer([]);

    if (txExtraPayload !== undefined) {
        var p2 = Buffer.concat([
            scriptSigPart2,
            util.packUInt32LE(txInSequence),
            //end transaction input

            //transaction output
            outputTransactions,
            //end transaction ouput

            util.packUInt32LE(txLockTime),
            txComment,
            util.varIntBuffer(txExtraPayload.length),
            txExtraPayload
        ]);
    } else {
        var p2 = Buffer.concat([
            scriptSigPart2,
            util.packUInt32LE(txInSequence),
            //end transaction input

            //transaction output
            outputTransactions,
            //end transaction ouput

            util.packUInt32LE(txLockTime),
            nExpiryHeight,
            valueBalance,
            vShieldedSpend,
            vShieldedOutput,
            nJoinSplit,
            txComment
        ]);
    };

    txHex = Buffer.concat([p1,p2]).toString('hex');


    const txBuffer = Buffer.from(txHex, 'hex');

    const hashBuffer = crypto.createHash('sha256').update(txBuffer).digest();
    // this txHash is used elsewhere. Don't remove it.
    txHash = crypto.createHash('sha256').update(hashBuffer).digest().reverse().toString('hex');

    return txHex;
};

module.exports.getFees = function(feeArray){
    var fee = Number();
    feeArray.forEach(function(value) {
        fee = fee + Number(value.fee);
    });
    return fee;
};
