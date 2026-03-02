const bip39 = require('bip39');
const hdkey = require('hdkey');
const bitcoin = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');
const { getAddressUTXOs, getTransactionHex, broadcastTransaction, getAddressBalance } = require('./blockchain');

const ECPair = ECPairFactory(tinysecp);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const ltcNet = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019da4e8 },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0
};

let root = null;
let initialized = false;

function initWallet(mnemonic) {
  console.log("[Wallet] Initializing...");

  if (!mnemonic) {
    console.error("❌ No BOT_MNEMONIC");
    return false;
  }

  const cleanMnemonic = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');

  try {
    if (!bip39.validateMnemonic(cleanMnemonic)) {
      console.error("❌ Invalid mnemonic");
      return false;
    }

    const seed = bip39.mnemonicToSeedSync(cleanMnemonic);
    root = hdkey.fromMasterSeed(seed);
    initialized = true;
    
    console.log(`✅ Wallet initialized`);
    console.log(`[0] ${generateAddress(0)}`);
    console.log(`[1] ${generateAddress(1)}`);
    console.log(`[2] ${generateAddress(2)}`);

    return true;
  } catch (err) {
    console.error("❌ Wallet init failed:", err.message);
    return false;
  }
}

function isInitialized() {
  return initialized && root !== null;
}

function generateAddress(index) {
  if (!isInitialized()) return null;
  
  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    const { address } = bitcoin.payments.p2wpkh({ 
      pubkey: child.publicKey, 
      network: ltcNet 
    });
    return address;
  } catch (err) {
    console.error(`[Wallet] Address ${index} failed:`, err.message);
    return null;
  }
}

function getPrivateKeyWIF(index) {
  if (!isInitialized()) return null;
  
  try {
    const child = root.derive(`m/44'/2'/0'/0/${index}`);
    
    if (!child.privateKey) {
      console.error(`[Wallet] No private key for index ${index}`);
      return null;
    }
    
    const keyPair = ECPair.fromPrivateKey(child.privateKey, { network: ltcNet });
    return keyPair.toWIF();
  } catch (err) {
    console.error(`[Wallet] Private key ${index} failed:`, err.message);
    return null;
  }
}

async function getBalanceAtIndex(index, forceRefresh = false) {
  if (!isInitialized()) return 0;
  
  const address = generateAddress(index);
  if (!address) return 0;
  
  const balance = await getAddressBalance(address);
  return balance.total || 0;
}

async function sendFromIndex(fromIndex, toAddress, amountLTC) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }

  const fromAddress = generateAddress(fromIndex);
  const wif = getPrivateKeyWIF(fromIndex);
  
  if (!fromAddress || !wif) {
    return { success: false, error: 'Could not derive keys' };
  }

  console.log(`[Wallet] Sending ${amountLTC} LTC from [${fromIndex}] to ${toAddress}`);

  try {
    const balanceData = await getAddressBalance(fromAddress);
    const currentBalance = balanceData.total;
    
    console.log(`[Wallet] Balance: ${currentBalance} LTC`);
    
    if (currentBalance <= 0) {
      return { success: false, error: `No balance in index ${fromIndex}` };
    }

    let utxos = await getAddressUTXOs(fromAddress);
    
    if (utxos.length === 0) {
      return { success: false, error: 'No UTXOs found' };
    }

    const amountSatoshi = Math.floor(parseFloat(amountLTC) * 1e8);
    const fee = 10000;
    const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);

    if (totalInput < amountSatoshi + fee) {
      return { success: false, error: `Insufficient balance` };
    }

    const psbt = new bitcoin.Psbt({ network: ltcNet });
    let inputSum = 0;

    for (const utxo of utxos) {
      if (inputSum >= amountSatoshi + fee) break;
      
      try {
        await delay(300);
        const txHex = await getTransactionHex(utxo.txid);
        
        if (!txHex) continue;
        
        psbt.addInput({
          hash: utxo.txid,
          index: utxo.vout,
          nonWitnessUtxo: Buffer.from(txHex, 'hex')
        });
        inputSum += utxo.value;
      } catch (err) {
        continue;
      }
    }

    if (psbt.inputCount === 0) {
      return { success: false, error: 'Could not add inputs' };
    }

    psbt.addOutput({ address: toAddress, value: amountSatoshi });
    
    const change = inputSum - amountSatoshi - fee;
    if (change > 546) {
      psbt.addOutput({ address: fromAddress, value: change });
    }

    const keyPair = ECPair.fromWIF(wif, ltcNet);
    
    for (let i = 0; i < psbt.inputCount; i++) {
      try {
        psbt.signInput(i, keyPair);
      } catch (e) {
        return { success: false, error: `Signing failed: ${e.message}` };
      }
    }

    psbt.finalizeAllInputs();
    const txHex = psbt.extractTransaction().toHex();

    const broadcastResult = await broadcastTransaction(txHex);
    
    if (broadcastResult.success) {
      return { 
        success: true, 
        txid: broadcastResult.txid,
        amountSent: (amountSatoshi / 1e8).toFixed(8)
      };
    } else {
      return { success: false, error: broadcastResult.error };
    }

  } catch (err) {
    console.error('[Wallet] Send error:', err);
    return { success: false, error: err.message };
  }
}

async function sendAllLTC(fromIndex, toAddress) {
  if (!isInitialized()) {
    return { success: false, error: 'Wallet not initialized' };
  }
  
  const balance = await getBalanceAtIndex(fromIndex, true);
  if (balance <= 0) {
    return { success: false, error: `No balance in index ${fromIndex}` };
  }
  
  const fee = 0.0001;
  const amountToSend = Math.max(0, balance - fee);
  
  if (amountToSend <= 0) {
    return { success: false, error: `Balance too low` };
  }
  
  console.log(`[Wallet] Sending ALL ${amountToSend} LTC from [${fromIndex}]`);
  return await sendFromIndex(fromIndex, toAddress, amountToSend.toFixed(8));
}

module.exports = { 
  initWallet, 
  isInitialized,
  generateAddress, 
  getPrivateKeyWIF, 
  getBalanceAtIndex, 
  sendAllLTC
};
