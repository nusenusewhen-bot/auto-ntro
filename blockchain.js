const axios = require('axios');

const BLOCKCHAIR_KEY = process.env.BLOCKCHAIR_KEY;
const BASE_URL = 'https://api.blockchair.com/litecoin';

let priceCache = { value: 0, timestamp: 0 };
const CACHE_DURATION = 60000;
let usePaidPlan = !!BLOCKCHAIR_KEY;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function blockchairRequest(endpoint) {
  try {
    let url = `${BASE_URL}${endpoint}`;
    
    if (BLOCKCHAIR_KEY && usePaidPlan) {
      url += `${endpoint.includes('?') ? '&' : '?'}key=${BLOCKCHAIR_KEY}`;
    }
    
    const res = await axios.get(url, { timeout: 30000 });
    
    if (res.data?.context?.error?.includes('credits') || res.data?.context?.error?.includes('limit')) {
      console.log('[Blockchair] Paid credits exhausted, falling back to free plan');
      usePaidPlan = false;
      return await blockchairRequestFree(endpoint);
    }
    
    return res.data.data;
  } catch (err) {
    if (err.response?.status === 402 || err.response?.status === 429) {
      console.log('[Blockchair] Paid plan hit limit, using free tier...');
      usePaidPlan = false;
      return await blockchairRequestFree(endpoint);
    }
    console.error(`[Blockchair] Error:`, err.message);
    return null;
  }
}

async function blockchairRequestFree(endpoint) {
  try {
    const res = await axios.get(`${BASE_URL}${endpoint}`, { timeout: 30000 });
    return res.data.data;
  } catch (err) {
    console.error(`[Blockchair Free] Error:`, err.message);
    return null;
  }
}

async function getAddressBalance(address) {
  const data = await
