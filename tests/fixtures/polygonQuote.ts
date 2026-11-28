import { abiWords } from './robinhood';

export function polygonQuoteResults(timestamp = Math.floor(Date.now() / 1000)) {
  return [
    abiWords(100, 10_000_000, timestamp - 10, timestamp - 10, 100), // $0.10/POL
    abiWords(8), abiWords(137), abiWords(timestamp),
  ].map((returnData) => ({ success: true, returnData }));
}
