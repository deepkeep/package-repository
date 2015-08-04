# Deepkeep packages repository

Hosts deepkeep packages

# Developing

Start by adding this to your `hosts` file:

```bash
192.168.59.103 packagess3 # or whatever ip your boot2docker runs on
```

You can then start the server with

```bash
docker-compose up
```

# Deploying in production

First time
```bash
git clone git@github.com:deepkeep/package-repository.git && cd package-repository
vim .env # Add all required environment variables
```

Then to deploy/re-deploy
```bash
cd package-repository
./deploy.sh
```
