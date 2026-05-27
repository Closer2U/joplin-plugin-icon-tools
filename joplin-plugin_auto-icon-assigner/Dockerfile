FROM node:20-bookworm-slim

WORKDIR /plugin
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run dist

# The built plugin is available in /plugin/publish/*.jpl inside the image.
# Example host build:
#   docker build -t joplin-auto-icon-assigner .
#   docker create --name jai joplin-auto-icon-assigner
#   docker cp jai:/plugin/publish ./publish
#   docker rm jai
