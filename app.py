import hmac
import csv
import io
import math
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from flask import make_response

from flask import Flask, abort, g, jsonify, redirect, render_template, request, session, url_for


BASE_DIR = Path(__file__).resolve().parent
DATABASE = Path(os.environ.get("ELECTRICITY_DB", BASE_DIR / "instance" / "electricity.db"))
PRODUCTION = os.environ.get("NEXUS_ENV", "development").lower() == "production"
AUTH_ENABLED = PRODUCTION or os.environ.get("NEXUS_AUTH_ENABLED", "").lower() == "true"
SECRET_KEY = os.environ.get("NEXUS_SECRET_KEY", "")
ADMIN_USERNAME = os.environ.get("NEXUS_ADMIN_USERNAME", "")
ADMIN_PASSWORD = os.environ.get("NEXUS_ADMIN_PASSWORD", "")

if PRODUCTION:
    missing = [
        name
        for name, value in (
            ("NEXUS_SECRET_KEY", SECRET_KEY),
            ("NEXUS_ADMIN_USERNAME", ADMIN_USERNAME),
            ("NEXUS_ADMIN_PASSWORD", ADMIN_PASSWORD),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(f"Production configuration is missing: {', '.join(missing)}")
    if len(SECRET_KEY) < 32:
        raise RuntimeError("NEXUS_SECRET_KEY must be at least 32 characters in production.")
    if len(ADMIN_PASSWORD) < 14:
        raise RuntimeError("NEXUS_ADMIN_PASSWORD must be at least 14 characters in production.")
elif AUTH_ENABLED:
    missing = [
        name
        for name, value in (
            ("NEXUS_SECRET_KEY", SECRET_KEY),
            ("NEXUS_ADMIN_USERNAME", ADMIN_USERNAME),
            ("NEXUS_ADMIN_PASSWORD", ADMIN_PASSWORD),
        )
        if not value
    ]
    if missing:
        raise RuntimeError(f"Authentication configuration is missing: {', '.join(missing)}")
    if len(SECRET_KEY) < 32:
        raise RuntimeError("NEXUS_SECRET_KEY must be at least 32 characters when authentication is enabled.")
    if len(ADMIN_PASSWORD) < 14:
        raise RuntimeError("NEXUS_ADMIN_PASSWORD must be at least 14 characters when authentication is enabled.")

app = Flask(__name__)
app.config.update(
    JSON_SORT_KEYS=False,
    SECRET_KEY=SECRET_KEY or secrets.token_hex(32),
    AUTH_ENABLED=AUTH_ENABLED,
    ADMIN_USERNAME=ADMIN_USERNAME,
    ADMIN_PASSWORD=ADMIN_PASSWORD,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=PRODUCTION,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
)


@app.before_request
def enforce_authentication_and_csrf():
    if not app.config["AUTH_ENABLED"] or request.endpoint in ("login", "static", "health_api"):
        return None
    if not session.get("authenticated"):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Authentication required."}), 401
        return redirect(url_for("login"))
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        expected = session.get("csrf_token", "")
        provided = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token", "")
        if not expected or not hmac.compare_digest(expected, provided):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Invalid or missing CSRF token."}), 400
            abort(400, description="Invalid or missing CSRF token.")
    return None


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "script-src 'self' https://cdn.jsdelivr.net; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; connect-src 'self'; object-src 'none'; "
        "base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    )
    if app.config["AUTH_ENABLED"]:
        response.headers.setdefault("Cache-Control", "no-store")
    if request.is_secure:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


def connect_db():
    DATABASE.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def get_db():
    if "db" not in g:
        g.db = connect_db()
    return g.db


@app.teardown_appcontext
def close_db(_error=None):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def init_db():
    db = connect_db()
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_number TEXT NOT NULL UNIQUE,
            floor_number INTEGER NOT NULL CHECK (floor_number > 0),
            average_monthly_consumption REAL NOT NULL CHECK (average_monthly_consumption >= 0),
            expected_consumption_limit REAL NOT NULL CHECK (expected_consumption_limit > 0),
            current_consumption REAL NOT NULL DEFAULT 0 CHECK (current_consumption >= 0),
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS consumption_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            consumption_kwh REAL NOT NULL CHECK (consumption_kwh >= 0),
            recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_history_room_time ON consumption_history(room_id, recorded_at);
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            alert_type TEXT NOT NULL,
            message TEXT NOT NULL,
            consumption REAL NOT NULL,
            expected_limit REAL NOT NULL,
            created_at TEXT NOT NULL,
            acknowledged INTEGER NOT NULL DEFAULT 0,
            acknowledged_at TEXT
        );
        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            electricity_price_per_kwh REAL NOT NULL DEFAULT 0.15,
            warning_threshold_percentage REAL NOT NULL DEFAULT 80,
            critical_threshold_percentage REAL NOT NULL DEFAULT 100,
            expected_increase_percentage REAL NOT NULL DEFAULT 20,
            refresh_interval_seconds INTEGER NOT NULL DEFAULT 15,
            sound_enabled INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS demo_simulations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            previous_consumption REAL NOT NULL,
            simulated_consumption REAL NOT NULL,
            alert_id INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            scenario TEXT NOT NULL DEFAULT 'spike'
        );
        CREATE TABLE IF NOT EXISTS demo_baseline (
            room_id INTEGER PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
            consumption_kwh REAL NOT NULL,
            captured_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO settings (id) VALUES (1);
        """
    )
    history_columns = {row["name"] for row in db.execute("PRAGMA table_info(consumption_history)")}
    if "notes" not in history_columns:
        db.execute("ALTER TABLE consumption_history ADD COLUMN notes TEXT NOT NULL DEFAULT ''")
    if "is_simulated" not in history_columns:
        db.execute("ALTER TABLE consumption_history ADD COLUMN is_simulated INTEGER NOT NULL DEFAULT 0")
    alert_columns = {row["name"] for row in db.execute("PRAGMA table_info(alerts)")}
    if "is_simulated" not in alert_columns:
        db.execute("ALTER TABLE alerts ADD COLUMN is_simulated INTEGER NOT NULL DEFAULT 0")
    settings_columns = {row["name"] for row in db.execute("PRAGMA table_info(settings)")}
    if "sound_enabled" not in settings_columns:
        db.execute("ALTER TABLE settings ADD COLUMN sound_enabled INTEGER NOT NULL DEFAULT 0")
    if "emissions_factor_kg_per_kwh" not in settings_columns:
        db.execute("ALTER TABLE settings ADD COLUMN emissions_factor_kg_per_kwh REAL NOT NULL DEFAULT 0.7")
    if "reason" not in alert_columns:
        db.execute("ALTER TABLE alerts ADD COLUMN reason TEXT NOT NULL DEFAULT ''")
    if "resolved" not in alert_columns:
        db.execute("ALTER TABLE alerts ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0")
    if "resolved_at" not in alert_columns:
        db.execute("ALTER TABLE alerts ADD COLUMN resolved_at TEXT")
    if "scenario" not in alert_columns:
        db.execute("ALTER TABLE alerts ADD COLUMN scenario TEXT NOT NULL DEFAULT ''")
    simulation_columns = {row["name"] for row in db.execute("PRAGMA table_info(demo_simulations)")}
    if "scenario" not in simulation_columns:
        db.execute("ALTER TABLE demo_simulations ADD COLUMN scenario TEXT NOT NULL DEFAULT 'spike'")
    count = db.execute("SELECT COUNT(*) FROM rooms").fetchone()[0]
    if count == 0:
        seed_demo_data(db)
    db.execute(
        """INSERT OR IGNORE INTO demo_baseline (room_id, consumption_kwh, captured_at)
           SELECT id, current_consumption, updated_at FROM rooms"""
    )
    db.commit()
    db.close()


def seed_demo_data(db):
    samples = [
        (101, 95, 114, 74), (102, 110, 132, 115), (103, 125, 150, 163),
        (104, 90, 108, 68), (105, 105, 126, 104),
        (201, 120, 144, 89), (202, 100, 120, 101), (203, 120, 144, 165),
        (204, 135, 162, 131), (205, 85, 102, 107),
        (301, 115, 138, 90), (302, 130, 156, 127), (303, 100, 120, 142),
        (304, 95, 114, 75), (305, 140, 168, 133),
    ]
    stamp = now_iso()
    for room_number, average, limit, current in samples:
        cursor = db.execute(
            """INSERT INTO rooms
               (room_number, floor_number, average_monthly_consumption,
                expected_consumption_limit, current_consumption, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (str(room_number), int(str(room_number)[0]), average, limit, current, stamp),
        )
        room_id = cursor.lastrowid
        for month_offset, multiplier in ((5, 0.82), (4, 0.91), (3, 0.87), (2, 0.96), (1, 0.93)):
            date = (datetime.now().astimezone().replace(day=1) - timedelta(days=month_offset * 30))
            db.execute(
                "INSERT INTO consumption_history (room_id, consumption_kwh, recorded_at) VALUES (?, ?, ?)",
                (room_id, round(average * multiplier, 1), date.isoformat(timespec="seconds")),
            )
        db.execute(
            "INSERT INTO consumption_history (room_id, consumption_kwh, recorded_at) VALUES (?, ?, ?)",
            (room_id, current, stamp),
        )
        percent = current / limit * 100
        alert_type = "CRITICAL" if current > limit else "WARNING" if percent >= 80 else None
        if alert_type:
            db.execute(
                """INSERT INTO alerts
                   (room_id, alert_type, message, consumption, expected_limit, created_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    room_id,
                    alert_type,
                    (
                        f"Room {room_number} is above its expected electricity limit."
                        if alert_type == "CRITICAL"
                        else f"Room {room_number} is approaching its expected electricity limit."
                    ),
                    current,
                    limit,
                    stamp,
                ),
            )


def settings_row(db=None):
    return dict((db or get_db()).execute("SELECT * FROM settings WHERE id = 1").fetchone())


def room_status(room, settings):
    if room.get("reading_state") == "stale" or room.get("reading_state") == "missing":
        return "No recent reading", 0
    percent = room["current_consumption"] / room["expected_consumption_limit"] * 100
    critical = settings["critical_threshold_percentage"]
    if percent > 100 or (critical < 100 and percent >= critical):
        status = "Critical"
    elif percent >= settings["warning_threshold_percentage"]:
        status = "Warning"
    else:
        status = "Normal"
    return status, round(percent, 1)


def serialize_room(row, settings):
    room = dict(row)
    latest = get_db().execute(
        """SELECT recorded_at, is_simulated FROM consumption_history
           WHERE room_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1""",
        (room["id"],),
    ).fetchone()
    room["last_reading_at"] = latest["recorded_at"] if latest else None
    room["current_is_simulated"] = bool(latest["is_simulated"]) if latest else False
    if latest is None:
        room["reading_state"] = "missing"
    else:
        try:
            reading_time = datetime.fromisoformat(latest["recorded_at"])
            room["reading_state"] = "stale" if datetime.now(reading_time.tzinfo) - reading_time > timedelta(days=45) else "current"
        except (TypeError, ValueError):
            room["reading_state"] = "stale"
    baseline = get_db().execute(
        """SELECT COUNT(*) FROM consumption_history
           WHERE room_id = ? AND is_simulated = 0""",
        (room["id"],),
    ).fetchone()[0]
    room["baseline_readings"] = baseline
    status, percent = room_status(room, settings)
    limit = room["expected_consumption_limit"]
    room.update(
        status=status,
        percent_of_limit=percent,
        remaining_allowance=round(max(limit - room["current_consumption"], 0), 2),
        excess_consumption=round(max(room["current_consumption"] - limit, 0), 2),
        estimated_cost=round(room["current_consumption"] * settings["electricity_price_per_kwh"], 2),
    )
    return room


def all_rooms(db=None, floor=None):
    db = db or get_db()
    if floor is None:
        rows = db.execute("SELECT * FROM rooms ORDER BY floor_number, room_number").fetchall()
    else:
        rows = db.execute(
            "SELECT * FROM rooms WHERE floor_number = ? ORDER BY room_number", (floor,)
        ).fetchall()
    settings = settings_row(db)
    return [serialize_room(row, settings) for row in rows]


def room_detail(room_id):
    db = get_db()
    row = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if row is None:
        return None
    room = serialize_room(row, settings_row(db))
    room["history"] = [
        dict(record)
        for record in db.execute(
            """SELECT id, consumption_kwh, recorded_at, notes, is_simulated FROM consumption_history
               WHERE room_id = ? ORDER BY recorded_at DESC LIMIT 12""",
            (room_id,),
        ).fetchall()
    ][::-1]
    room["recent_alerts"] = [
        dict(alert)
        for alert in db.execute(
            """SELECT id, alert_type, message, reason, consumption, expected_limit, created_at,
                      acknowledged, acknowledged_at, resolved, resolved_at, is_simulated, scenario
               FROM alerts WHERE room_id = ? ORDER BY created_at DESC LIMIT 10""",
            (room_id,),
        ).fetchall()
    ]
    return room


def create_status_alert(db, room, reading, alert_type, reason=None):
    excess = round(reading - room["expected_consumption_limit"], 2)
    excess_pct = round(excess / room["expected_consumption_limit"] * 100, 2)
    baseline = float(room["average_monthly_consumption"])
    baseline_count = db.execute(
        "SELECT COUNT(*) FROM consumption_history WHERE room_id = ? AND is_simulated = 0",
        (room["id"],),
    ).fetchone()[0]
    reason = reason or (
        f"Current reading {reading:.1f} kWh; expected limit {room['expected_consumption_limit']:.1f} kWh; "
        f"historical baseline {baseline:.1f} kWh from {baseline_count} saved non-simulated readings."
    )
    if alert_type == "CRITICAL":
        message = (
            f"Floor {room['floor_number']}, Room {room['room_number']}: "
            f"{reading:.1f} kWh against a {room['expected_consumption_limit']:.1f} kWh limit "
            f"({excess:.1f} kWh / {excess_pct:.2f}% over)."
        )
    elif alert_type == "WARNING":
        message = (
            f"Floor {room['floor_number']}, Room {room['room_number']} is at "
            f"{reading:.1f} kWh, approaching its {room['expected_consumption_limit']:.1f} kWh limit."
        )
    else:
        message = (
            f"Floor {room['floor_number']}, Room {room['room_number']} returned to "
            f"{reading:.1f} kWh, within its {room['expected_consumption_limit']:.1f} kWh expected limit."
        )
    cursor = db.execute(
        """INSERT INTO alerts
           (room_id, alert_type, message, consumption, expected_limit, created_at,
            reason, resolved, resolved_at, acknowledged, acknowledged_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            room["id"], alert_type, message, reading, room["expected_consumption_limit"],
            now_iso(), reason, int(alert_type == "NORMAL"),
            now_iso() if alert_type == "NORMAL" else None,
            int(alert_type == "NORMAL"), now_iso() if alert_type == "NORMAL" else None,
        ),
    )
    return cursor.lastrowid


def resolve_room_alerts(db, room_id, stamp=None):
    stamp = stamp or now_iso()
    db.execute(
        """UPDATE alerts SET resolved = 1, resolved_at = ?,
           acknowledged = 1, acknowledged_at = COALESCE(acknowledged_at, ?)
           WHERE room_id = ? AND alert_type IN ('WARNING', 'CRITICAL')
             AND acknowledged = 0 AND resolved = 0""",
        (stamp, stamp, room_id),
    )


def json_error(message, status=400):
    return jsonify({"error": message}), status


@app.get("/")
def index():
    csrf_token = session.setdefault("csrf_token", secrets.token_urlsafe(32))
    username = app.config["ADMIN_USERNAME"] if app.config["AUTH_ENABLED"] else "Building admin"
    return render_template(
        "dashboard.html",
        csrf_token=csrf_token,
        username=username,
        auth_enabled=app.config["AUTH_ENABLED"],
    )


@app.route("/login", methods=["GET", "POST"])
def login():
    if not app.config["AUTH_ENABLED"]:
        return redirect(url_for("index"))
    csrf_token = session.setdefault("csrf_token", secrets.token_urlsafe(32))
    error = None
    if request.method == "POST":
        submitted_token = request.form.get("csrf_token", "")
        if not submitted_token or not hmac.compare_digest(csrf_token, submitted_token):
            abort(400, description="Invalid or missing CSRF token.")
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        valid_username = hmac.compare_digest(username, app.config["ADMIN_USERNAME"])
        valid_password = hmac.compare_digest(password, app.config["ADMIN_PASSWORD"])
        if valid_username and valid_password:
            session.clear()
            session.permanent = True
            session["authenticated"] = True
            session["csrf_token"] = secrets.token_urlsafe(32)
            return redirect(url_for("index"))
        error = "The username or password is incorrect."
        csrf_token = session.setdefault("csrf_token", secrets.token_urlsafe(32))
    return render_template("login.html", csrf_token=csrf_token, error=error), (401 if error else 200)


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.get("/api/dashboard")
def dashboard_api():
    rooms = all_rooms()
    db = get_db()
    settings = settings_row(db)
    active_alerts = db.execute(
        """SELECT a.*, r.room_number, r.floor_number
           FROM alerts a JOIN rooms r ON r.id = a.room_id
           WHERE a.acknowledged = 0 ORDER BY a.created_at DESC"""
    ).fetchall()
    recent_rooms = [room for room in rooms if room["reading_state"] == "current"]
    total = round(sum(room["current_consumption"] for room in recent_rooms), 2)
    today = datetime.now().astimezone()
    daily_run_rate = round(total / max(today.day, 1), 2)
    return jsonify(
        {
            "summary": {
                "floor_count": len({room["floor_number"] for room in rooms}),
                "room_count": len(rooms),
                "rooms_without_recent_readings": len(rooms) - len(recent_rooms),
                "total_consumption": total,
                "normal_count": sum(room["status"] == "Normal" for room in recent_rooms),
                "warning_count": sum(room["status"] == "Warning" for room in recent_rooms),
                "critical_count": sum(room["status"] == "Critical" for room in recent_rooms),
                "estimated_cost": round(total * settings["electricity_price_per_kwh"], 2),
                "estimated_daily_run_rate": daily_run_rate,
                "potential_savings": round(
                    sum(max(room["current_consumption"] - room["expected_consumption_limit"], 0)
                        for room in rooms) * settings["electricity_price_per_kwh"],
                    2,
                ),
                "estimated_emissions_kg": round(total * settings["emissions_factor_kg_per_kwh"], 2),
            },
            "rooms": rooms,
            "alerts": [dict(alert) for alert in active_alerts],
            "settings": settings,
            "active_simulation": bool(
                db.execute("SELECT 1 FROM demo_simulations WHERE active = 1 LIMIT 1").fetchone()
            ),
            "generated_at": now_iso(),
        }
    )


@app.get("/api/floors")
def floors_api():
    rooms = all_rooms()
    floors = []
    settings = settings_row()
    for floor_number in sorted({room["floor_number"] for room in rooms}):
        floor_rooms = [room for room in rooms if room["floor_number"] == floor_number]
        consumption = sum(room["current_consumption"] for room in floor_rooms)
        floors.append(
            {
                "floor_number": floor_number,
                "rooms": floor_rooms,
                "room_count": len(floor_rooms),
                "consumption": round(consumption, 2),
                "estimated_cost": round(consumption * settings["electricity_price_per_kwh"], 2),
            }
        )
    return jsonify(floors)


@app.get("/api/rooms")
def rooms_api():
    floor = request.args.get("floor", type=int)
    return jsonify(all_rooms(floor=floor))


@app.get("/api/rooms/<int:room_id>")
def room_api(room_id):
    room = room_detail(room_id)
    return jsonify(room) if room else json_error("Room not found.", 404)


def validate_room_input(data, creating=False):
    if not isinstance(data, dict):
        return None, "Expected a JSON object."
    try:
        room_number = str(data.get("room_number", "")).strip()
        floor_value = float(data.get("floor_number"))
        if not floor_value.is_integer():
            return None, "Floor number must be a whole number."
        floor = int(floor_value)
        average = float(data.get("average_monthly_consumption"))
        expected = float(data.get("expected_consumption_limit"))
        current = float(data.get("current_consumption", 0))
    except (TypeError, ValueError):
        return None, "Provide a room number, floor, average, expected limit, and valid current reading."
    if not room_number or len(room_number) > 20:
        return None, "Room number must contain 1 to 20 characters."
    if floor < 1:
        return None, "Floor number must be positive."
    if not all(math.isfinite(value) for value in (average, expected, current)):
        return None, "Consumption values must be finite numbers."
    if average < 0 or expected <= 0 or current < 0:
        return None, "Consumption values cannot be negative, and the expected limit must be positive."
    return {
        "room_number": room_number,
        "floor_number": floor,
        "average_monthly_consumption": average,
        "expected_consumption_limit": expected,
        "current_consumption": current,
    }, None


@app.post("/api/rooms")
def add_room_api():
    data, error = validate_room_input(request.get_json(silent=True), creating=True)
    if error:
        return json_error(error)
    db = get_db()
    stamp = now_iso()
    try:
        cursor = db.execute(
            """INSERT INTO rooms
               (room_number, floor_number, average_monthly_consumption,
                expected_consumption_limit, current_consumption, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                data["room_number"],
                data["floor_number"],
                data["average_monthly_consumption"],
                data["expected_consumption_limit"],
                data["current_consumption"],
                stamp,
            ),
        )
        room_id = cursor.lastrowid
        db.execute(
            "INSERT OR IGNORE INTO demo_baseline (room_id, consumption_kwh, captured_at) VALUES (?, ?, ?)",
            (room_id, data["current_consumption"], stamp),
        )
        db.execute(
            "INSERT INTO consumption_history (room_id, consumption_kwh, recorded_at) VALUES (?, ?, ?)",
            (room_id, data["current_consumption"], stamp),
        )
        new_alert_id = None
        room = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
        settings = settings_row(db)
        status = room_status(dict(room), settings)[0]
        if status in ("Warning", "Critical"):
            new_alert_id = create_status_alert(db, dict(room), data["current_consumption"], status.upper())
        db.commit()
    except sqlite3.IntegrityError:
        return json_error("That room number already exists.", 409)
    result = room_detail(room_id)
    result["new_alert_id"] = new_alert_id
    return jsonify(result), 201


@app.put("/api/rooms/<int:room_id>")
def update_room_api(room_id):
    data, error = validate_room_input(request.get_json(silent=True))
    if error:
        return json_error(error)
    db = get_db()
    previous = db.execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()
    if previous is None:
        return json_error("Room not found.", 404)
    settings = settings_row(db)
    previous_state = serialize_room(previous, settings)
    previous_status = previous_state["status"]
    stamp = now_iso()
    try:
        db.execute(
            """UPDATE rooms SET room_number = ?, floor_number = ?,
               average_monthly_consumption = ?, expected_consumption_limit = ?,
               current_consumption = ?, updated_at = ? WHERE id = ?""",
            (
                data["room_number"], data["floor_number"], data["average_monthly_consumption"],
                data["expected_consumption_limit"], data["current_consumption"], stamp, room_id,
            ),
        )
        if data["current_consumption"] != previous["current_consumption"]:
            db.execute(
                "INSERT INTO consumption_history (room_id, consumption_kwh, recorded_at) VALUES (?, ?, ?)",
                (room_id, data["current_consumption"], stamp),
            )
        updated = dict(previous)
        updated.update(data)
        updated["reading_state"] = "current" if data["current_consumption"] != previous["current_consumption"] else previous_state["reading_state"]
        new_alert_id = None
        new_status = room_status(updated, settings)[0]
        if previous_status != new_status and new_status in ("Warning", "Critical"):
            new_alert_id = create_status_alert(db, updated, data["current_consumption"], new_status.upper())
        db.commit()
    except sqlite3.IntegrityError:
        return json_error("That room number already exists.", 409)
    result = room_detail(room_id)
    result["new_alert_id"] = new_alert_id
    return jsonify(result)


@app.post("/api/consumption")
def consumption_api():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return json_error("Expected a JSON object.")
    try:
        reading = float(data.get("consumption_kwh", data.get("consumption")))
        room_id = data.get("room_id")
        room_number = str(data.get("room_number", "")).strip()
        if room_id is not None:
            room = get_db().execute("SELECT * FROM rooms WHERE id = ?", (int(room_id),)).fetchone()
        elif room_number:
            room = get_db().execute("SELECT * FROM rooms WHERE room_number = ?", (room_number,)).fetchone()
        else:
            return json_error("Provide room_id or room_number.")
    except (TypeError, ValueError):
        return json_error("Provide a valid room identifier and numeric reading.")
    if not math.isfinite(reading):
        return json_error("Consumption reading must be a finite number.")
    if reading < 0:
        return json_error("Consumption reading cannot be negative.")
    notes = data.get("notes", "")
    if not isinstance(notes, str) or len(notes) > 500:
        return json_error("Notes must be text with a maximum of 500 characters.")
    recorded_at = now_iso()
    if data.get("recorded_at"):
        try:
            recorded_at = datetime.fromisoformat(str(data["recorded_at"])).astimezone().isoformat(timespec="seconds")
        except (TypeError, ValueError, OverflowError):
            return json_error("Provide a valid ISO 8601 reading date and time.")
    if room is None:
        return json_error("Room not found.", 404)
    db = get_db()
    settings = settings_row(db)
    previous_state = serialize_room(room, settings)
    previous_status = previous_state["status"]
    latest_history = db.execute(
        """SELECT consumption_kwh, recorded_at FROM consumption_history
           WHERE room_id = ? ORDER BY recorded_at DESC, id DESC LIMIT 1""",
        (room["id"],),
    ).fetchone()
    if latest_history:
        submitted_time = datetime.fromisoformat(recorded_at)
        latest_time = datetime.fromisoformat(latest_history["recorded_at"])
        if submitted_time < latest_time:
            db.execute(
                """INSERT INTO consumption_history
                   (room_id, consumption_kwh, recorded_at, notes, is_simulated)
                   VALUES (?, ?, ?, ?, 0)""",
                (room["id"], reading, recorded_at, notes.strip()),
            )
            db.commit()
            result = room_detail(room["id"])
            result["new_alert_id"] = None
            result["historical_only"] = True
            return jsonify(result)
    historical = db.execute(
        """SELECT consumption_kwh FROM consumption_history
           WHERE room_id = ? AND is_simulated = 0 ORDER BY recorded_at DESC, id DESC LIMIT 5""",
        (room["id"],),
    ).fetchall()
    baseline_values = [float(item["consumption_kwh"]) for item in historical]
    baseline_count = len(baseline_values)
    baseline = sum(baseline_values) / baseline_count if baseline_count else None
    warning_limit = room["expected_consumption_limit"] * settings["warning_threshold_percentage"] / 100
    consecutive_high = 0
    for previous_reading in historical:
        if float(previous_reading["consumption_kwh"]) >= warning_limit:
            consecutive_high += 1
        else:
            break
    sustained = consecutive_high >= 2 and reading >= warning_limit
    stamp = now_iso()
    db.execute("UPDATE rooms SET current_consumption = ?, updated_at = ? WHERE id = ?", (reading, stamp, room["id"]))
    db.execute(
        """INSERT INTO consumption_history
           (room_id, consumption_kwh, recorded_at, notes, is_simulated)
           VALUES (?, ?, ?, ?, 0)""",
        (room["id"], reading, recorded_at, notes.strip()),
    )
    updated = dict(room)
    updated["current_consumption"] = reading
    updated["reading_state"] = "current"
    new_status = room_status(updated, settings)[0]
    alert_id = None
    anomaly_reason = None
    if sustained:
        anomaly_reason = (
            f"Possible sustained high use: this reading and the prior {consecutive_high} saved "
            f"non-simulated readings are at/above {warning_limit:.1f} kWh "
            f"({settings['warning_threshold_percentage']:.0f}% of the {room['expected_consumption_limit']:.1f} kWh limit). "
            "Snapshots indicate persistence, not continuous usage or confirmed wastage."
        )
    elif baseline is not None and baseline_count >= 3 and baseline > 0 and reading >= baseline * 1.5:
        anomaly_reason = (
            f"Possible sudden increase: {reading:.1f} kWh is at least 150% of "
            f"the {baseline:.1f} kWh mean from {baseline_count} saved non-simulated readings. "
            "Inspect the room; this does not confirm wastage."
        )
    if previous_status != new_status:
        if new_status in ("Warning", "Critical"):
            resolve_room_alerts(db, room["id"], stamp)
            alert_id = create_status_alert(db, updated, reading, new_status.upper(), anomaly_reason)
        else:
            resolve_room_alerts(db, room["id"], stamp)
            alert_id = create_status_alert(db, updated, reading, "NORMAL")
    elif anomaly_reason:
        existing = db.execute(
            """SELECT 1 FROM alerts WHERE room_id = ? AND acknowledged = 0
               AND resolved = 0 AND reason LIKE ? LIMIT 1""",
            (room["id"], "%Possible %"),
        ).fetchone()
        if existing is None:
            cursor = db.execute(
                """INSERT INTO alerts
                   (room_id, alert_type, message, consumption, expected_limit, created_at, reason)
                   VALUES (?, 'WARNING', ?, ?, ?, ?, ?)""",
                (
                    room["id"],
                    f"Floor {room['floor_number']}, Room {room['room_number']} has a possible sudden usage increase.",
                    reading,
                    room["expected_consumption_limit"],
                    stamp,
                    anomaly_reason,
                ),
            )
            alert_id = cursor.lastrowid
    db.commit()
    result = room_detail(room["id"])
    result["new_alert_id"] = alert_id
    return jsonify(result)


@app.post("/api/demo/simulate")
def simulate_critical_api():
    db = get_db()
    if db.execute("SELECT 1 FROM demo_simulations WHERE active = 1 LIMIT 1").fetchone():
        return json_error("A simulation is already active. Stop it before starting another.", 409)
    data = request.get_json(silent=True) or {}
    scenario = data.get("scenario", "spike")
    if scenario not in {"normal", "spike", "sustained", "after_hours"}:
        return json_error("Scenario must be normal, spike, sustained, or after_hours.")
    rooms = all_rooms(db)
    room_id = data.get("room_id")
    candidates = [room for room in rooms if room["reading_state"] == "current"]
    if room_id is not None:
        candidates = [room for room in candidates if room["id"] == room_id]
    else:
        candidates = [room for room in candidates if room["status"] != "Critical"]
    if not candidates:
        return json_error("No eligible room is available for this simulation.", 409)
    room = min(candidates, key=lambda item: item["percent_of_limit"]) if scenario != "normal" else max(candidates, key=lambda item: item["percent_of_limit"])
    previous = room["current_consumption"]
    if scenario == "normal":
        reading = round(min(room["expected_consumption_limit"] * .5, room["expected_consumption_limit"] - .1), 1)
    elif scenario == "sustained":
        reading = round(max(room["expected_consumption_limit"] * 1.12, previous + .1), 1)
    elif scenario == "after_hours":
        reading = round(max(room["expected_consumption_limit"] * 1.08, previous + .1), 1)
    else:
        reading = round(max(room["expected_consumption_limit"] * 1.3, previous + .1), 1)
    reading = max(reading, 0)
    stamp = now_iso()
    db.execute(
        "UPDATE rooms SET current_consumption = ?, updated_at = ? WHERE id = ?",
        (reading, stamp, room["id"]),
    )
    notes = {
        "normal": "SIMULATED normal usage scenario",
        "spike": "SIMULATED sudden energy spike scenario",
        "sustained": "SIMULATED sustained high usage scenario; three synthetic snapshots",
        "after_hours": "SIMULATED after-hours scenario; not inferred from a monthly meter reading",
    }[scenario]
    if scenario == "sustained":
        for minutes_ago in (10, 5):
            sample_stamp = (datetime.now().astimezone() - timedelta(minutes=minutes_ago)).isoformat(timespec="seconds")
            db.execute(
                """INSERT INTO consumption_history
                   (room_id, consumption_kwh, recorded_at, notes, is_simulated)
                   VALUES (?, ?, ?, ?, 1)""",
                (room["id"], reading, sample_stamp, notes),
            )
    db.execute(
        """INSERT INTO consumption_history
           (room_id, consumption_kwh, recorded_at, notes, is_simulated)
           VALUES (?, ?, ?, ?, 1)""",
        (room["id"], reading, stamp, notes),
    )
    simulated_room = dict(room, current_consumption=reading, reading_state="current")
    simulated_status = room_status(simulated_room, settings_row(db))[0]
    alert_id = None
    if simulated_status in ("Warning", "Critical"):
        alert_id = create_status_alert(db, simulated_room, reading, simulated_status.upper())
        explanation = {
            "spike": f"Simulated spike: {reading:.1f} kWh vs expected limit {room['expected_consumption_limit']:.1f} kWh.",
            "sustained": f"Three simulated readings near {reading:.1f} kWh were added to demonstrate sustained high use.",
            "after_hours": f"Simulated after-hours event at {reading:.1f} kWh. A monthly cumulative reading cannot independently establish after-hours wastage.",
        }.get(scenario, "Simulated usage scenario.")
        db.execute(
            "UPDATE alerts SET is_simulated = 1, scenario = ?, reason = ? WHERE id = ?",
            (scenario, explanation, alert_id),
        )
    else:
        alert_id = create_status_alert(db, simulated_room, reading, "NORMAL")
        db.execute(
            "UPDATE alerts SET is_simulated = 1, scenario = ?, reason = ? WHERE id = ?",
            (scenario, "Simulated normal usage; no wastage indication.", alert_id),
        )
    db.execute(
        """INSERT INTO demo_simulations
           (room_id, previous_consumption, simulated_consumption, alert_id, created_at, scenario)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (room["id"], previous, reading, alert_id, stamp, scenario),
    )
    db.commit()
    return jsonify(
        {
            "message": f"Simulated {scenario} reading created.",
            "simulated": True,
            "scenario": scenario,
            "alert_id": alert_id,
            "room": room_detail(room["id"]),
        }
    ), 201


@app.post("/api/demo/simulation/stop")
def stop_simulation_api():
    db = get_db()
    simulation = db.execute(
        "SELECT * FROM demo_simulations WHERE active = 1 ORDER BY id DESC LIMIT 1"
    ).fetchone()
    if simulation is None:
        return json_error("There is no active simulation to stop.", 404)
    stamp = now_iso()
    db.execute(
        "UPDATE rooms SET current_consumption = ?, updated_at = ? WHERE id = ?",
        (simulation["previous_consumption"], stamp, simulation["room_id"]),
    )
    db.execute(
        """INSERT INTO consumption_history
           (room_id, consumption_kwh, recorded_at, notes, is_simulated)
           VALUES (?, ?, ?, 'Demo simulation restored', 1)""",
        (simulation["room_id"], simulation["previous_consumption"], stamp),
    )
    if simulation["alert_id"] is not None:
        db.execute(
            """UPDATE alerts SET acknowledged = 1, acknowledged_at = ?,
               resolved = 1, resolved_at = ? WHERE id = ?""",
            (stamp, stamp, simulation["alert_id"]),
        )
    db.execute("UPDATE demo_simulations SET active = 0 WHERE id = ?", (simulation["id"],))
    db.commit()
    return jsonify(
        {
            "message": "Simulation stopped; the original room reading was restored.",
            "room": room_detail(simulation["room_id"]),
        }
    )


@app.get("/api/consumption/history")
def history_api():
    db = get_db()
    room_id = request.args.get("room_id", type=int)
    floor = request.args.get("floor", type=int)
    start_date = request.args.get("start")
    end_date = request.args.get("end")
    query = """SELECT h.id, h.room_id, r.room_number, r.floor_number,
                      h.consumption_kwh, h.recorded_at, h.notes, h.is_simulated
               FROM consumption_history h JOIN rooms r ON r.id = h.room_id WHERE 1=1"""
    params = []
    if room_id is not None:
        query += " AND h.room_id = ?"
        params.append(room_id)
    if floor is not None:
        query += " AND r.floor_number = ?"
        params.append(floor)
    if start_date:
        query += " AND date(h.recorded_at) >= date(?)"
        params.append(start_date)
    if end_date:
        query += " AND date(h.recorded_at) <= date(?)"
        params.append(end_date)
    query += " ORDER BY h.recorded_at ASC LIMIT 1000"
    return jsonify([dict(row) for row in db.execute(query, params).fetchall()])


@app.get("/api/alerts")
def alerts_api():
    db = get_db()
    severity = request.args.get("severity")
    floor = request.args.get("floor", type=int)
    room_id = request.args.get("room_id", type=int)
    start_date = request.args.get("start")
    end_date = request.args.get("end")
    query = """SELECT a.*, r.room_number, r.floor_number
               FROM alerts a JOIN rooms r ON r.id = a.room_id WHERE 1=1"""
    params = []
    if severity in ("NORMAL", "WARNING", "CRITICAL"):
        query += " AND a.alert_type = ?"
        params.append(severity)
    if floor is not None:
        query += " AND r.floor_number = ?"
        params.append(floor)
    if room_id is not None:
        query += " AND a.room_id = ?"
        params.append(room_id)
    if start_date:
        query += " AND date(a.created_at) >= date(?)"
        params.append(start_date)
    if end_date:
        query += " AND date(a.created_at) <= date(?)"
        params.append(end_date)
    query += " ORDER BY a.created_at DESC LIMIT 500"
    return jsonify([dict(row) for row in db.execute(query, params).fetchall()])


@app.post("/api/alerts/<int:alert_id>/acknowledge")
def acknowledge_alert_api(alert_id):
    db = get_db()
    cursor = db.execute(
        "UPDATE alerts SET acknowledged = 1, acknowledged_at = ? WHERE id = ? AND acknowledged = 0",
        (now_iso(), alert_id),
    )
    if cursor.rowcount == 0:
        exists = db.execute("SELECT 1 FROM alerts WHERE id = ?", (alert_id,)).fetchone()
        if exists is None:
            return json_error("Alert not found.", 404)
    db.commit()
    return jsonify({"id": alert_id, "acknowledged": True})


@app.post("/api/alerts/<int:alert_id>/resolve")
def resolve_alert_api(alert_id):
    db = get_db()
    alert = db.execute(
        "SELECT id, room_id, alert_type, resolved FROM alerts WHERE id = ?",
        (alert_id,),
    ).fetchone()
    if alert is None:
        return json_error("Alert not found.", 404)
    if alert["resolved"]:
        return jsonify({"id": alert_id, "resolved": True})
    if alert["alert_type"] not in ("WARNING", "CRITICAL"):
        return json_error("Only warning and critical alerts can be resolved.", 409)
    room = db.execute("SELECT * FROM rooms WHERE id = ?", (alert["room_id"],)).fetchone()
    room_state = serialize_room(room, settings_row(db))
    if room_state["reading_state"] != "current" or room_state["status"] != "Normal":
        return json_error("Save a current reading within the normal range before resolving this alert.", 409)
    stamp = now_iso()
    db.execute(
        """UPDATE alerts SET resolved = 1, resolved_at = ?, acknowledged = 1,
           acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ? AND resolved = 0""",
        (stamp, stamp, alert_id),
    )
    db.commit()
    return jsonify({"id": alert_id, "resolved": True})


@app.get("/api/settings")
def get_settings_api():
    return jsonify(settings_row())


@app.put("/api/settings")
def update_settings_api():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return json_error("Expected a JSON object.")
    current = settings_row()
    try:
        price = float(data.get("electricity_price_per_kwh", current["electricity_price_per_kwh"]))
        warning = float(data.get("warning_threshold_percentage", current["warning_threshold_percentage"]))
        critical = float(data.get("critical_threshold_percentage", current["critical_threshold_percentage"]))
        increase = float(data.get("expected_increase_percentage", current["expected_increase_percentage"]))
        interval_value = float(data.get("refresh_interval_seconds", current["refresh_interval_seconds"]))
        emissions_factor = float(data.get("emissions_factor_kg_per_kwh", current["emissions_factor_kg_per_kwh"]))
    except (TypeError, ValueError):
        return json_error("All settings must be valid numeric values.")
    if not all(math.isfinite(value) for value in (price, warning, critical, increase, interval_value, emissions_factor)):
        return json_error("Settings must contain finite numeric values.")
    if not interval_value.is_integer():
        return json_error("Refresh interval must be a whole number of seconds.")
    interval = int(interval_value)
    if price < 0 or emissions_factor < 0 or not (0 <= warning < critical <= 100) or increase < 0 or interval < 5 or interval > 300:
        return json_error("Use non-negative price/increase/emissions factor, 0 <= warning < critical <= 100, and refresh interval 5-300 seconds.")
    sound_enabled = data.get("sound_enabled", current["sound_enabled"])
    if sound_enabled not in (True, False, 0, 1):
        return json_error("Sound enabled must be a boolean value.")
    db = get_db()
    previous_rooms = [dict(row) for row in db.execute("SELECT * FROM rooms").fetchall()]
    previous_settings = current
    db.execute(
        """UPDATE settings SET electricity_price_per_kwh = ?,
           warning_threshold_percentage = ?, critical_threshold_percentage = ?,
           expected_increase_percentage = ?, refresh_interval_seconds = ?, sound_enabled = ?,
           emissions_factor_kg_per_kwh = ? WHERE id = 1""",
        (price, warning, critical, increase, interval, int(sound_enabled), emissions_factor),
    )
    db.execute(
        "UPDATE rooms SET expected_consumption_limit = average_monthly_consumption * (1 + ? / 100.0)",
        (increase,),
    )
    updated_settings = settings_row(db)
    for previous_room in previous_rooms:
        previous_status = serialize_room(previous_room, previous_settings)["status"]
        updated_room = db.execute("SELECT * FROM rooms WHERE id = ?", (previous_room["id"],)).fetchone()
        new_status = serialize_room(updated_room, updated_settings)["status"]
        if previous_status != new_status and new_status in ("Warning", "Critical"):
            create_status_alert(db, dict(updated_room), updated_room["current_consumption"], new_status.upper())
    db.commit()
    return jsonify(settings_row(db))


@app.post("/api/demo/reset")
def reset_demo_api():
    db = get_db()
    stamp = now_iso()
    baseline_rows = db.execute("SELECT room_id, consumption_kwh FROM demo_baseline").fetchall()
    for baseline in baseline_rows:
        db.execute(
            "UPDATE rooms SET current_consumption = ?, updated_at = ? WHERE id = ?",
            (baseline["consumption_kwh"], stamp, baseline["room_id"]),
        )
    db.execute("UPDATE demo_simulations SET active = 0 WHERE active = 1")
    db.execute(
        """UPDATE alerts SET acknowledged = 1, acknowledged_at = COALESCE(acknowledged_at, ?),
           resolved = 1, resolved_at = COALESCE(resolved_at, ?)
           WHERE is_simulated = 1 AND resolved = 0""",
        (stamp, stamp),
    )
    db.execute(
        """INSERT INTO consumption_history (room_id, consumption_kwh, recorded_at, notes, is_simulated)
           SELECT room_id, consumption_kwh, ?, 'Demo reset: restored original sample reading', 1
           FROM demo_baseline""",
        (stamp,),
    )
    db.execute(
        """UPDATE settings SET electricity_price_per_kwh = 0.15,
           warning_threshold_percentage = 80, critical_threshold_percentage = 100,
           expected_increase_percentage = 20, refresh_interval_seconds = 15,
           sound_enabled = 0, emissions_factor_kg_per_kwh = 0.7 WHERE id = 1"""
    )
    db.commit()
    return jsonify({"message": "Demo readings restored. Existing readings and alert history were preserved."})


@app.get("/api/health")
def health_api():
    return jsonify({"status": "ok", "database": "connected"})


@app.get("/api/reports.csv")
def reports_csv_api():
    today = datetime.now().astimezone().date()
    start_date = request.args.get("start", today.replace(day=1).isoformat())
    end_date = request.args.get("end", today.isoformat())
    try:
        start = datetime.fromisoformat(start_date).date()
        end = datetime.fromisoformat(end_date).date()
    except (TypeError, ValueError):
        return json_error("Report dates must use YYYY-MM-DD.")
    if start > end:
        return json_error("Report start date must be on or before its end date.")
    db = get_db()
    settings = settings_row(db)
    rooms = all_rooms(db)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["Nexus Energy summary report", f"{start.isoformat()} to {end.isoformat()}"])
    writer.writerow(["Assumption", "Cost = recorded kWh × configured tariff; estimates only"])
    writer.writerow(["Tariff per kWh", settings["electricity_price_per_kwh"]])
    writer.writerow(["Emissions factor kg CO2e/kWh", settings["emissions_factor_kg_per_kwh"]])
    writer.writerow(["Record type", "Floor", "Room", "Recorded at", "Consumption kWh", "Expected limit kWh", "Estimated cost", "Status / severity", "Source", "Acknowledged", "Resolved", "Reason / notes"])
    recent_rooms = [room for room in rooms if room["reading_state"] == "current"]
    total = sum(room["current_consumption"] for room in recent_rooms)
    writer.writerow(["Current summary", "", "", "", round(total, 2), "", round(total * settings["electricity_price_per_kwh"], 2), "", "latest saved room readings", "", "", "Current snapshot; not interval usage"])
    excess = sum(room["excess_consumption"] for room in recent_rooms)
    writer.writerow(["Potential savings estimate", "", "", "", round(excess, 2), "", round(excess * settings["electricity_price_per_kwh"], 2), "", "estimate only", "", "", "Excess above configured room limits; not guaranteed recoverable"])
    floor_numbers = sorted({room["floor_number"] for room in rooms})
    for floor in floor_numbers:
        floor_rooms = [room for room in recent_rooms if room["floor_number"] == floor]
        floor_total = sum(room["current_consumption"] for room in floor_rooms)
        writer.writerow(["Floor summary", floor, "", "", round(floor_total, 2), "", round(floor_total * settings["electricity_price_per_kwh"], 2), "", "latest saved room readings", "", "", "Estimated"])
    history = db.execute(
        """SELECT h.recorded_at, h.consumption_kwh, h.notes, h.is_simulated,
                  r.room_number, r.floor_number, r.expected_consumption_limit
           FROM consumption_history h JOIN rooms r ON r.id = h.room_id
           WHERE date(h.recorded_at) BETWEEN date(?) AND date(?)
           ORDER BY h.recorded_at""",
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    for record in history:
        writer.writerow([
            "Reading", record["floor_number"], record["room_number"], record["recorded_at"],
            record["consumption_kwh"], record["expected_consumption_limit"],
            round(record["consumption_kwh"] * settings["electricity_price_per_kwh"], 2),
            "", "simulated" if record["is_simulated"] else "manual/demo",
            "", "", record["notes"],
        ])
    alerts = db.execute(
        """SELECT a.*, r.room_number, r.floor_number FROM alerts a
           JOIN rooms r ON r.id = a.room_id
           WHERE date(a.created_at) BETWEEN date(?) AND date(?)
           ORDER BY a.created_at""",
        (start.isoformat(), end.isoformat()),
    ).fetchall()
    for alert in alerts:
        writer.writerow([
            "Alert", alert["floor_number"], alert["room_number"], alert["created_at"],
            alert["consumption"], alert["expected_limit"],
            round(alert["consumption"] * settings["electricity_price_per_kwh"], 2),
            alert["alert_type"], "simulated" if alert["is_simulated"] else "manual/demo",
            bool(alert["acknowledged"]), bool(alert["resolved"]),
            alert["reason"] or alert["message"],
        ])
    response = make_response(output.getvalue())
    response.headers["Content-Type"] = "text/csv; charset=utf-8"
    response.headers["Content-Disposition"] = f'attachment; filename="nexus-energy-{start.isoformat()}-to-{end.isoformat()}.csv"'
    return response


init_db()


if __name__ == "__main__":
    if PRODUCTION:
        raise SystemExit("Run production mode with a WSGI server such as Waitress; Flask's development server is disabled.")
    app.run(debug=not PRODUCTION and os.environ.get("FLASK_DEBUG", "").lower() == "true")
