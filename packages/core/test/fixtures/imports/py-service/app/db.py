from app import config


def connect():
    return config.DATABASE_URL
