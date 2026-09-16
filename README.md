# BUMP

**The loser cashes out.**

One message slot, shared by everyone in the app. Take it by paying 1.5x what the
current holder paid. That payment goes straight to the person you took it from,
so getting beaten is the outcome you want. The only person out of pocket is
whoever is holding when the day closes, and they keep their message in the hall
of fame for good. One winner a day.

A Mini App for [Nimiq Pay](https://nimiq.com).

## How a round works

The slot opens at a floor of 100 NIM and each bump costs 1.5x the last price.
The day closes at 19:00 UTC, when whoever is holding keeps their message and the
price drops back to the floor for tomorrow. Taking the slot inside the final two
minutes pushes the close out by two, so the day cannot be won by turning up a
second before the end.

| | Pays | To | Receives | Net |
|---|---|---|---|---|
| Aoife | 100 | previous winner | 150 from Ben | +50 |
| Ben | 150 | Aoife | 225 from Cal | +75 |
| Cal | 225 | Ben | 100 from tomorrow's opening bid | -125, keeps the slot |

Everyone who loses the slot walks away with 50% more than they put in. Cal pays
for permanence. The opening bid of every day goes to the winner of the day
before it.

## No chance element

BUMP is not a game of chance and has no pot. The price is on screen at all
times, before you commit and after. Nothing is drawn, rolled, or randomised.
Taking the slot is buying one advertising position at a published price, from a
seller who profits on the sale.

## Why it runs on Nimiq

A ten bump round is twenty transactions. On a chain with real fees, the gas
alone ends the game before it starts. Nimiq settles in about a second for a
fraction of a cent, which is what lets a bid cost three cents and still be worth
making.

## How payment works

Nothing is held in custody. When you bump, your wallet pays the current holder
directly, and the app never touches the money.

1. You tap Bump. The server issues a claim: a one time token, the exact price in
   Luna, and the holder's address. The claim locks the slot for 60 seconds.
2. Your wallet sends that payment with the token attached as the memo.
3. The server watches the chain for a payment to that address carrying that
   token.
4. The slot changes hands as soon as the transaction is included, marked as
   still settling.
5. It is confirmed once a macro block finalises it.

Nimiq's one second figure describes inclusion, not finality. Micro blocks are
reversible up to 59 blocks deep, and Albatross writes failed transactions to the
chain as well as successful ones. So a transaction existing proves nothing on
its own. Before the server accepts a bump it checks all of:

```
executionResult === true
recipient       === the holder named in the claim
value           >= the price named in the claim
networkId       === 24
memo            === the claim token
confirmations   >= 60
```

## Architecture

The whole slot is one Cloudflare Durable Object. Because a Durable Object runs
single threaded, two people bumping in the same second are serialised by the
platform, so the race is gone rather than guarded against.

```
src/worker.ts    router, static assets, SSE stream
src/slot.ts      the Durable Object: state, claims, the daily close, the tape
src/verify.ts    chain polling and the checks above
src/moderate.ts  message and name screening before any payment is requested
src/nimiq.ts     Luna maths, addresses, name sanitising, provider error unwrapping
```

Live updates go over Server Sent Events rather than WebSocket. WebSocket is not
confirmed to work inside the Nimiq Pay WebView, and SSE is already running in
production in another Mini App. Mobile WebViews suspend when backgrounded, so
the client reconnects and resyncs its state instead of assuming the stream
survived.

## Running it

You need Node 20 or newer and a phone with Nimiq Pay installed.

```bash
npm install
npm run dev -- --host
```

Open Nimiq Pay, go to Mini Apps, choose Custom URL, and paste the Network URL
that Wrangler prints. It looks like `http://192.168.1.20:8787`. Do not use
localhost, because inside the WebView that means the phone itself.

To test without spending anything, long press the settings button for about ten
seconds. A hidden developer menu appears with a network switch. On testnet the
home screen grows a Get free NIM button worth 110,000 test NIM. The switch
covers NIM only, so anything on an EVM chain stays on mainnet.

```bash
npm test          # unit tests
npm run copycheck # screens all shipped copy for AI writing patterns
```

## Licence

MIT. See [LICENSE](LICENSE).
