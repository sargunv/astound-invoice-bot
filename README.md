# astound-invoice-bot

This is a bot for automatically downloading and emailing new invoice PDFs from Astound Broadband's website. I use it to automate submitting invoices for filing reimbursements from my employer every month.

## Setup

The container will run once and then exit. You can schedule it with ofelia. For example, with Docker Compose:

```yml
services:
  astound-invoice-bot:
    container_name: astound-invoice-bot
    image: ghcr.io/sargunv/astound-invoice-bot:main
    volumes:
      - ./astound-invoice-bot:/data
    environment:
      - ASTOUND_USERNAME=${ASTOUND_USERNAME:?}
      - ASTOUND_PASSWORD=${ASTOUND_PASSWORD:?}
      - SMTP_HOST=${SMTP_HOST:?}
      - SMTP_USER=${SMTP_USER:?}
      - SMTP_PASSWORD=${SMTP_PASSWORD:?}
      - EMAIL_FROM=${SMTP_USER:?}
      - EMAIL_TO=${EMAIL_TO:?}
    restart: on-failure:3
  ofelia:
    container_name: ofelia
    image: mcuadros/ofelia:latest
    command: daemon --docker
    depends_on:
      - astound-invoice-bot
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    labels:
      - ofelia.job-run.astound-invoice-bot.container=astound-invoice-bot
      - ofelia.job-run.astound-invoice-bot.schedule=@daily
    restart: unless-stopped
```
