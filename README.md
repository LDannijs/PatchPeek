# 👀 PatchPeek

PatchPeek fetches the changelog of GitHub releases with the GitHub API, while checking for any potential breaking changes and puts it into a clean interface.

![](screenshot.png)

## Features

- Minimalistic interface
- Minimal usage of API tokens
- Changelogs with breaking changes are highlighted
- Add repos by github url or only the author/repo slug
- Change the amount of days to look back for releases

## IMPORTANT INFO

- This app is intended to have a window of 31 days (My personal interval of updating containers) and while it does work if you enter 365 days for example, be aware of heavy GitHub API usage and longer load times. Just so you know, I am not condoning usage this far back, as I have not tested the rigidity of it.

- The app pulls releases from the GitHub API every 1 hour, which should provide enough requests for your needs without a GitHub token (but it is recommended to add one).

## Docker Compose

> [!NOTE]
> The container runs as root, but has the option to run rootless. Read the Important note carefully.

- Create a directory and add a `docker-compose.yaml` file with the following contents:

```
services:
  patchpeek:
    image: ghcr.io/ldannijs/patchpeek:latest
    container_name: patchpeek
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
    # Uncomment the next line to run container as non-root user (node)
    # user: "1000:1000"
```

> [!IMPORTANT]
> To run the container as rootless, uncomment the line as seen in the compose file, and then make sure you run:
>
> ```
> sudo chown -R 1000:1000 ./data
> ```

- Then run:

```
docker compose up -d
```

Github token creation can be found here: https://github.com/settings/personal-access-tokens

## Locally running / Development

> [!NOTE]
> This project requires at least `Node 18`

- Clone the repo
- Open a terminal in the `PatchPeek` folder
- Then run:

```
npm install
npm run dev
```

## Roadmap

- Search function
- Create logo?

## Motivation

This project came to fruition from me wanting to quickly know if any updates I were to do to my docker containers would break anything. I have used RSS feeds, discord notifications, etc. but they all felt too cumbersome to quickly check.

Besides that I wanted to push myself to make a project like this and see how far i could push it and learn stuff from it :) This is very much a passion project from someone without a ton of knowledge so mistakes will very likely have been made.
