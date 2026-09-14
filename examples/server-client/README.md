# Notifkit Server & Client Example

This example demonstrates how to:

1. Boot the full Notifkit Server with API and Admin Dashboard (`server.js`).
2. Interact with the running server using the typed `NotifkitClient` SDK (`client.js`).
3. Log into the built Admin Dashboard at `http://localhost:3000/admin`.

---

## 1. Start the Server

Before running the server, ensure your project bundles are built:

```bash
# From repository root:
npm run build
npm run build:dashboard
```

Run the server script:

```bash
node examples/server-client/server.js
```

The server will start at `http://localhost:3000` with the following default credentials:

- **Admin Dashboard**: [http://localhost:3000/admin](http://localhost:3000/admin)
- **Email**: `admin@example.com`
- **Password**: `admin123`

---

## 2. Run the Client SDK

In another terminal, execute the client script:

```bash
node examples/server-client/client.js
```

The client script will:

- Sync notification templates (`welcome_notification` and `security_alert`).
- Upsert recipient user `usr_alex_99` with email and SMS contact channels.
- Dispatch a notification.
- Check the task delivery status.

You can view the real-time events and history logs immediately in your dashboard at `http://localhost:3000/admin`!
