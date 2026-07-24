from flask import Flask, Blueprint

app = Flask(__name__)
api = Blueprint("api", __name__, url_prefix="/api")


@app.route("/health")
def health():
    return "ok"


@app.get("/version")
def version():
    return "1.0"


@app.route("/submit", methods=["POST", "PUT"])
def submit():
    return "done"


@api.route("/users/<int:user_id>")
def get_user(user_id):
    return str(user_id)


@api.post("/users")
def create_user():
    return "created"


app.register_blueprint(api)
