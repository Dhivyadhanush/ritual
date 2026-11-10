# Putting Ritual on your domain

`ntfy.example.com` is served by **Cloudflare Tunnel**. `cloudflared` runs as a
container on your server (`cloudflared ... tunnel --token …`) and the public hostnames live in
the **Cloudflare Zero Trust dashboard**, not in a local `config.yml`. That is why the
hostname has to be added in the dashboard, and why `cloudflared` restarting does not change
routes.

Adding Ritual is four steps.

---

## 1. Add the public hostname

Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → select the active
tunnel (the one already serving `ntfy.example.com`) → **Public Hostname** → **Add a
public hostname**.

| Field | Value |
| --- | --- |
| Subdomain | `ritual` |
| Domain | `example.com` |
| Path | *(leave empty)* |
| Service type | `HTTP` |
| URL | `172.17.0.1:4322` |

Why `172.17.0.1` and not `localhost`: `cloudflared` is a **bridge-network container**, so
`localhost` points at the cloudflared container itself. `172.17.0.1` is the Docker host
gateway, where Ritual publishes 4322. This was tested from a default-bridge container:

```
$ docker run --rm --network bridge alpine:3.20 \
    wget -qO- http://172.17.0.1:4322/api/health
{"ok":true,"time":"2026-11-10T02:31:50.275Z"}
```

`your-server:4322` also works, but the gateway address does not depend on Wi-Fi.

Save. Cloudflare creates a proxied `CNAME ritual.example.com` pointing at the tunnel.
Allow a minute, then:

```bash
curl -I https://ritual.example.com
```

You should see Cloudflare headers and either the app or the Access login redirect.

> No DNS record to add manually. If the dashboard does not create it, add a proxied CNAME
> named `ritual` with target `<tunnel-id>.cfargotunnel.com`.

---

## 2. Point the app’s buttons at the domain

The notification buttons use `HEALTH_BASE_URL`. Either change it in the dashboard
(**Settings → Dashboard URL**) or on your server:

```dotenv
HEALTH_BASE_URL=https://ritual.example.com
```

Then restart/recreate so the first-boot config is not involved — or simply save it in the
dashboard, which is the source of truth after first boot. New notifications will use
`https://ritual.example.com/a/...`.

If you want the buttons to keep working only on the home Wi-Fi for now, leave
`HEALTH_BASE_URL=http://your-server:4322`.

---

## 3. Protect the dashboard

The app now has its **own single-user login page**, so it is already private without
Cloudflare Access. Access is optional and adds a second factor (email OTP) in front of the
app login. Pick one:

- **App login only** — skip this section. The domain shows the Ritual login page.
- **App login + Cloudflare Access** — do the steps below for 2FA.

**Zero Trust → Access → Applications → Add an application → Self-hosted**

- Application name: `Ritual`
- Public hostname: `ritual.example.com`
- Session duration: 24 hours (or your preference)
- Policy: **Allow** → Include → **Emails** → your email; require email OTP/PIN.
- Save.

Then add a **second Access application** for the notification endpoints, using a path and
a **Bypass** policy:

| Setting | Value |
| --- | --- |
| Application name | `Ritual actions` |
| Public hostname | `ritual.example.com` |
| Path | `a` |
| Policy action | Bypass |
| Include | Everyone |

Cloudflare prefers the most specific path, so `/a/*` bypasses Access while the rest of
`/` and `/api/*` stays behind the Allow policy. (If your dashboard only allows policies
inside one application, create the app with Path `a` and a Bypass policy — two apps on the
same hostname is the supported pattern.)

Why: the ntfy app makes the button request from the phone with **no Cloudflare session**
and no app login, so Access would return a login page and the button would fail. `/a/*`
is already protected by a 48-character `ACTION_TOKEN` inside the URL, and it can only
change water/habit state — it cannot read health data.

If you skip Cloudflare Access entirely, no bypass is needed; `/a/*` is still token-guarded
and the dashboard is protected by the Ritual login page.

Leave `/api/*` protected. The dashboard’s own requests happen after you log in and carry
the Access cookie.

Do **not** bypass `/api/checkin` or `/api/water` — those are the un-tokenized dashboard
endpoints.

---

## 4. Verify

```bash
# Should show the app login page (302 to /login), or Access first if you enabled it
curl -I https://ritual.example.com

# Button endpoint without the token: 401
curl -s -o /dev/null -w '%{http_code}\n' https://ritual.example.com/a/water?delta=0

# With the token it returns 200 (read it from your server, don't paste it around)
ssh user@server 'cd /home/user/ritual && grep ACTION_TOKEN .env'
```

Then on the phone:

1. Open `https://ritual.example.com`, log in through Access.
2. In ntfy, subscribe to topic **`ritual`** (server `https://ntfy.example.com`,
   user `your-username`).
3. Enable **ntfy** under Zepp → Devices → watch → Notification and Reminders → App
   Notification.
4. Trigger **Send test** in Ritual and confirm it arrives on the watch.
5. Tap **+1 glass** / **Yes** on a notification; the dashboard should update.

---

## How the action token works

- `ACTION_TOKEN` is a 48-hex-character secret set once on your server (`.env`, mode 600, and
  `data/config.json`, mode 600).
- Notification URLs look like
  `https://…/a/checkin?id=no-sugar&done=1&date=2026-11-10&t=<token>`.
- `/a/water` and `/a/checkin` return `401 Bad action token` without the correct `t=`.
- `/api/*` and the dashboard do **not** require it; they rely on Cloudflare Access (or
  LAN access).
- Rotating the token: generate a new one, update `.env`, and `PUT /api/config`
  `{"security":{"actionToken":"…"}}`; old notifications stop working, new ones use it.

The token is intentionally not exposed in `/api/bootstrap` (only `actionTokenSet: true`).

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Cloudflare 502 | Tunnel service URL is wrong. Use `http://172.17.0.1:4322`, not `localhost`. |
| Cloudflare 1033 / tunnel offline | The tunnel container is down; check `docker ps` for `cloudflared`. |
| Access login loop | Cookie/email policy issue; test in a private window. |
| Notification buttons return 401 | Missing/old `t=` token. Generate new notifications (or rotate and update config). |
| Buttons return an Access login page | `/a/*` bypass missing or ordered after Allow. |
| Dashboard loads but API 401 | Access session expired; refresh and log in. |
| Dashboard is public | Access application not attached to the hostname. |
| `ritual.example.com` NXDOMAIN | Public hostname not saved, or DNS record not proxied. |

## Notes

- The tunnel is **remote-managed**. Editing `/etc/cloudflared/config.yml` or restarting
  the container will not add routes. Use the dashboard (or a scoped Cloudflare API token
  with Tunnel + DNS edit).
- A subpath like `https://ntfy.example.com/ritual/` is not recommended: the app uses
  absolute `/app.js`, `/styles.css`, `/api/...` paths. A subdomain is clean.
- The app listens on `0.0.0.0:4322`; Cloudflare is the only public entry point. ufw also
  restricts 4322 to the two LAN subnets.
