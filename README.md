![zkSYS Portal](public/preview.png)

# zkSYS Portal

**zkSYS Portal** is an open-source Syscoin community integration for bridging, token management, and transaction history on zkSYS.

## Features

- Manage, send, and bridge TSYS and supported tokens.
- Discover token metadata through the Syscoin Blockscout-based registry.
- Connect to the Syscoin Tanenbaum L1 and zkSYS Tanenbaum L2 networks.

## Development

**Prerequisites:** Node.js version 20+, npm version 7+

1. Clone the Portal repository and set it up:
   ```bash
   git clone https://github.com/syscoin/dapp-portal.git
   cd dapp-portal
   npm install
   ```
2. Launch the dev server:
   ```bash
   npm run dev
   ```
3. Open the displayed local URL, typically `http://localhost:3000`.

---

## Connecting to Hyperchain

To use Portal with your ZK Stack Hyperchain, see the guide [here](./hyperchains/README.md).

---

### Advanced configuration

#### L1 Balances:

By default, L1 balances are fetched via a public RPC. For faster loading speeds and reduced load on your L1 RPC provider, consider using [Ankr's RPC service](https://www.ankr.com/rpc/). Obtain an Ankr token and update the `.env` file:

```bash
ANKR_TOKEN=your_ankr_token_here
```

#### Wallet Connect Project Setup

Before deploying your own version of the Portal, ensure you create your own Wallet Connect project on [walletconnect.com](https://walletconnect.com). After creating the project, update the project ID in the `.env` file:

```bash
WALLET_CONNECT_PROJECT_ID=your_project_id_here
```

#### Error logging with [Sentry](https://sentry.io/)

In the .env file, add the Sentry variables:
```bash
SENTRY_DSN=your_sentry_dsn_url_here
SENTRY_ENV=localhost # 'localhost' | 'production'
```
SENTRY_ENV variable is used in order to filter the issues by environment. 

### Setup

Ensure you've installed the necessary dependencies:

```bash
npm install
```

### Development Server

Activate the dev server at http://localhost:3000:

```bash
npm run dev
```

### Production

Compile for production:

```bash
npm run generate
```

📘 Familiarize yourself with the [Nuxt 3 documentation](https://nuxt.com/docs/getting-started/introduction) for a deeper dive.

---

## Contributing

Contributions are welcome through the [Syscoin dapp-portal repository](https://github.com/syscoin/dapp-portal/pulls).

---

## License

Released under the [MIT License](https://github.com/syscoin/dapp-portal/blob/main/LICENSE).
