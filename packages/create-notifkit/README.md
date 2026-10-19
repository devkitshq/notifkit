# create-notifkit

Scaffold a [notifkit](https://notifkit.dev) app: a server, a client that sends a test notification, and a `.env` with a generated admin key.

```bash
npm create notifkit@latest my-app
# or
npx notifkit create my-app
```

You need Node 22+ and Docker running. In development notifkit starts throwaway PostgreSQL and Redis containers for you.

```bash
cd my-app
npm run dev      # start the server, leave it running
```

In a second terminal:

```bash
npm run setup    # create a project and save its API key to .env
npm run send     # send a test notification
```

With the default `console` provider the notification is printed in the server terminal, so this works without any provider account.

## Options

```
create-notifkit [name] [options]

  -p, --provider <id>  console (default), resend, twilio, fcm
      --no-install     Skip installing dependencies
      --force          Write into a non-empty directory
  -h, --help           Show help
  -v, --version        Show the version
```

Pass `.` as the name to scaffold into the current directory. With no name in an interactive terminal, it asks for the name and provider. pnpm, yarn and bun are detected when you run it through them (`pnpm create notifkit`).

## What you get

| File           | Purpose                                                        |
| :------------- | :------------------------------------------------------------- |
| `server.ts`    | `NotifkitServer` with the provider you picked                  |
| `setup.ts`     | Creates a project and writes `NOTIFKIT_API_KEY` to `.env`      |
| `send.ts`      | `NotifkitClient`: sync a template, add a user, notify them     |
| `.env`         | A random `ADMIN_API_KEY`, plus blanks for provider credentials |
| `.env.example` | The same variables with no values, safe to commit              |

`.env` is in `.gitignore`.
