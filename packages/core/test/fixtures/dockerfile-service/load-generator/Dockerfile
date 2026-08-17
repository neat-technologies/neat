FROM grafana/k6:latest

WORKDIR /app
COPY script.js people.json ./
COPY entrypoint.sh ./

EXPOSE 6565

ENTRYPOINT ["/app/entrypoint.sh"]
