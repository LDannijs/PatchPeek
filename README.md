# PatchPeek

PatchPeek fetches the changelog of GitHub releases with the GitHub API, while checking for any potential breaking changes and puts it into a clean interface.

![](screenshot.png)

This project came to fruition from me wanting to quickly know if any updates I were to do to my docker containers would break anything. I have used RSS feeds and the likes but they all felt too cumbersome to quickly check.

## INFO

It is recommended to not show releases from more then 90 days or so. This is quite a simple javascript application, so the backend isn't as robust to show a lot further then that. I have not thoroughly tested it on how far back it can go while being stable. This app was mostly intended to be used every month when I usually update all my containers.

The app pulls releases from the GitHub API every 30 minutes, and caches it based on the `If-None-Match` request header. This is to use less requests from the API then needed.

## Running locally

> [!NOTE]
> This project requires at least `Node 18`

- Clone the repo
- Open a terminal in the `PatchPeek` folder
- Then run:

```
npm install
npm start
```
