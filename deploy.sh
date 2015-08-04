docker stop deepkeep-package-repository
git pull
docker build -t deepkeep-package-repository .
docker run -p 80:80 --env-file .env -d --name deepkeep-package-repository deepkeep-package-repository
