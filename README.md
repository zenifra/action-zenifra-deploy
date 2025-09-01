# action-zenifra
This GitHub Action facilitates the deployment of images to [Zenifra](https://www.zenifra.com), a platform designed to streamline application hosting and management.

## Input parameters

| Name           | Description                            | Required | Default          |
| :------------- | :------------------------------------- | :------- | :--------------- |
| IMAGE          | The URL to be deployed on Zenifra      | `true`   | N/A              |
| PROJECT_ID     | The ID of the project on Zenifra       | `true`   | N/A              |
| API_KEY        | The API_KEY of the project on Zenifra  | `true`   | N/A              |

## Example

The example below demonstrates a complete workflow that builds and publishes an image to Docker Hub, followed by deploying this new image on Zenifra.

```yaml
name: Deploy PRD
on:
  push: 
    branches: 
      - main

jobs:
  build: # Job to build and publish the image
    name: build
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@main

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v2

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Log in to Docker Registry
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Build and Publish Docker Image
        run: docker buildx build -t <registry>/<username-docker>/<name-image>:<tag> --platform=linux/amd64 --push .

  deploy: # Job to deploy the Docker image on Zenifra
    needs: build
    name: deploy
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code 
        uses: actions/checkout@main

      - name: Deploy Image to Zenifra
        uses: ramonpaolo/action-zenifra@main
        with:
          PROJECT_ID: <project-id>
          IMAGE: <registry>/<username-docker>/<name-image>:<tag>
          API_KEY: <api-key>
