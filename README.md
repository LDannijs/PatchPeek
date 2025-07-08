# 👀 PatchPeek (WIP)

PatchPeek fetches the changelog of GitHub releases with the GitHub API, while checking for any potential breaking changes and puts it into a clean interface.

![](screenshot.png)

This project came to fruition from me wanting to quickly know if any updates I were to do to my docker containers would break anything. I have used RSS feeds and the likes but they all felt too cumbersome to quickly check.

## IMPORTANT INFO

- It is recommended that you do not show releases from more then 90 days or so. This is quite a simple javascript application, so the backend isn't as robust and I have not thoroughly tested it. This app is intended to be used once every month when I personally update all my containers.

- The app pulls releases from the GitHub API every 1 hour, and caches it based on the `If-None-Match` request header. This is to use less requests from the API then needed. Considering it only uses the API once every hour, running the app without a GitHub token should provide enough requests for your needs. Of course, adding one is available.

## Docker Compose

The image for this container is not yet published to docker hub (will do soon), so the following guide is not complete.

> [!NOTE]
> The container runs as root, but has the option to run rootless.

### Run as root

- Clone the repo
- Open a terminal in the `PatchPeek` folder
- Then run:

```
docker compose up -d --build
```

### Run as rootless

To run the container as rootless:

- Clone the repo
- Open the `docker-compose.yaml` file and uncomment the following line:

```
    # user: "1000:1000"
```

- Open a terminal in the `PatchPeek` folder
- Then make sure you run:

```
sudo chown -R 1000:1000 ./data
```

- And finally run the container with:

```
docker compose up -d --build
```

## Locally running / Development

> [!NOTE]
> This project requires at least `Node 18`

- Clone the repo
- Open a terminal in the `PatchPeek` folder
- Then run:

```
npm install
npm dev
```
