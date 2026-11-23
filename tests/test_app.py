import tempfile
import unittest
from pathlib import Path

import app as wattwatch


class WattWatchApiTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_database = wattwatch.DATABASE
        self.original_auth_config = {
            key: wattwatch.app.config[key]
            for key in ("AUTH_ENABLED", "ADMIN_USERNAME", "ADMIN_PASSWORD")
        }
        wattwatch.DATABASE = Path(self.temp_dir.name) / "test-electricity.db"
        wattwatch.init_db()
        wattwatch.app.config.update(TESTING=True, AUTH_ENABLED=False)
        self.client = wattwatch.app.test_client()

    def tearDown(self):
        wattwatch.DATABASE = self.original_database
        wattwatch.app.config.update(self.original_auth_config)
        self.temp_dir.cleanup()

    def test_authentication_csrf_and_security_headers(self):
        wattwatch.app.config.update(
            AUTH_ENABLED=True,
            ADMIN_USERNAME="building-admin",
            ADMIN_PASSWORD="a sufficiently long demo password",
        )
        protected_page = self.client.get("/")
        self.assertEqual(protected_page.status_code, 302)
        self.assertTrue(protected_page.headers["Location"].endswith("/login"))
        self.assertEqual(self.client.get("/api/dashboard").status_code, 401)
        self.assertEqual(self.client.get("/api/health").status_code, 200)

        login_page = self.client.get("/login")
        self.assertEqual(login_page.status_code, 200)
        with self.client.session_transaction() as browser_session:
            csrf_token = browser_session["csrf_token"]
        rejected = self.client.post(
            "/login",
            data={"username": "building-admin", "password": "wrong password", "csrf_token": csrf_token},
        )
        self.assertEqual(rejected.status_code, 401)
        accepted = self.client.post(
            "/login",
            data={
                "username": "building-admin",
                "password": "a sufficiently long demo password",
                "csrf_token": csrf_token,
            },
        )
        self.assertEqual(accepted.status_code, 302)
        self.assertEqual(self.client.get("/api/dashboard").status_code, 200)
        self.assertEqual(
            self.client.post("/api/demo/simulate").status_code,
            400,
        )
        with self.client.session_transaction() as browser_session:
            csrf_token = browser_session["csrf_token"]
        created = self.client.post(
            "/api/demo/simulate",
            json={},
            headers={"X-CSRF-Token": csrf_token},
        )
        self.assertEqual(created.status_code, 201)
        logout = self.client.post("/logout", data={"csrf_token": csrf_token})
        self.assertEqual(logout.status_code, 302)
        self.assertEqual(self.client.get("/api/dashboard").status_code, 401)
        self.assertEqual(login_page.headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(login_page.headers["X-Frame-Options"], "DENY")
        self.assertIn("frame-ancestors 'none'", login_page.headers["Content-Security-Policy"])

    def room(self, number="101"):
        rooms = self.client.get("/api/rooms").get_json()
        return next(room for room in rooms if room["room_number"] == number)

    def test_seeded_demo_and_health(self):
        response = self.client.get("/api/dashboard")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["summary"]["room_count"], 15)
        self.assertGreater(response.get_json()["summary"]["estimated_daily_run_rate"], 0)
        self.assertGreater(response.get_json()["summary"]["critical_count"], 0)
        self.assertEqual(self.client.get("/api/health").get_json()["status"], "ok")
        dashboard = self.client.get("/").data
        self.assertIn(b"WattWatch", dashboard)
        self.assertIn(b'id="building-model"', dashboard)
        self.assertIn(b'data-building-floor="3"', dashboard)
        self.assertIn(b'aria-label="Interactive three-floor building room map"', dashboard)
        self.assertIn(b'energy-reference-16', dashboard)
        self.assertIn(b'id="building-floorplan-map"', dashboard)
        self.assertIn(b'id="dashboard-reduction"', dashboard)
        self.assertIn(b'id="dashboard-tariff-form"', dashboard)
        self.assertIn(b'id="dashboard-carbon-bars"', dashboard)
        self.assertIn(b'id="dashboard-insights"', dashboard)
        self.assertIn(b'id="rail-quick-actions"', dashboard)
        self.assertIn(b'data-dashboard-target="dashboard-savings-panel"', dashboard)
        self.assertIn(b'id="header-time"', dashboard)
        self.assertNotIn(b'rail-capabilities-panel', dashboard)

    def test_status_threshold_boundaries(self):
        with wattwatch.app.app_context():
            settings = wattwatch.settings_row()
        base = {"expected_consumption_limit": 100}
        for value, expected in ((79.9, "Normal"), (80, "Warning"), (100, "Warning"), (100.1, "Critical")):
            with self.subTest(value=value):
                room = dict(base, current_consumption=value)
                self.assertEqual(wattwatch.room_status(room, settings)[0], expected)

    def test_warning_transition_creates_warning_alert_without_sound_event(self):
        room = self.room()
        response = self.client.post("/api/consumption", json={"room_id": room["id"], "consumption_kwh": 100})
        new_alert_id = response.get_json()["new_alert_id"]
        self.assertIsNotNone(new_alert_id)
        alerts = self.client.get("/api/alerts").get_json()
        created = next(alert for alert in alerts if alert["id"] == new_alert_id)
        self.assertEqual(created["alert_type"], "WARNING")

    def test_critical_transition_deduplication_acknowledgement_and_reentry(self):
        room = self.room()
        url = "/api/consumption"
        critical = {"room_id": room["id"], "consumption_kwh": 140}
        first = self.client.post(url, json=critical).get_json()
        self.assertIsNotNone(first["new_alert_id"])
        still_critical = self.client.post(url, json=critical).get_json()
        self.assertIsNone(still_critical["new_alert_id"])
        alert_id = first["new_alert_id"]
        self.assertEqual(self.client.post(f"/api/alerts/{alert_id}/acknowledge").status_code, 200)
        self.client.post(url, json={"room_id": room["id"], "consumption_kwh": 70})
        reentry = self.client.post(url, json=critical).get_json()
        self.assertIsNotNone(reentry["new_alert_id"])
        self.assertNotEqual(alert_id, reentry["new_alert_id"])

    def test_alert_resolution_requires_normal_current_reading(self):
        room = self.room()
        alert_id = self.client.post(
            "/api/consumption",
            json={"room_id": room["id"], "consumption_kwh": 140},
        ).get_json()["new_alert_id"]
        self.assertEqual(self.client.post(f"/api/alerts/{alert_id}/resolve").status_code, 409)
        self.assertEqual(self.client.post(f"/api/alerts/{alert_id}/acknowledge").status_code, 200)
        self.client.post(
            "/api/consumption",
            json={"room_id": room["id"], "consumption_kwh": 50},
        )
        resolved = self.client.post(f"/api/alerts/{alert_id}/resolve")
        self.assertEqual(resolved.status_code, 200)
        alert = next(item for item in self.client.get("/api/alerts").get_json() if item["id"] == alert_id)
        self.assertTrue(alert["resolved"])
        self.assertTrue(alert["acknowledged"])
        self.assertIsNotNone(alert["resolved_at"])

    def test_invalid_reading_and_room_values_are_rejected(self):
        room = self.room()
        self.assertEqual(self.client.post("/api/consumption", json={"room_id": room["id"], "consumption_kwh": -1}).status_code, 400)
        self.assertEqual(self.client.post("/api/consumption", json={"room_id": room["id"], "consumption_kwh": "bad"}).status_code, 400)
        self.assertEqual(self.client.post("/api/consumption", data='{"room_id": 1, "consumption_kwh": NaN}', content_type="application/json").status_code, 400)
        self.assertEqual(self.client.post("/api/rooms", json={
            "room_number": "999", "floor_number": 1, "average_monthly_consumption": 10,
            "expected_consumption_limit": 12, "current_consumption": -2,
        }).status_code, 400)
        fractional_floor = self.client.post("/api/rooms", json={
            "room_number": "998", "floor_number": 1.5, "average_monthly_consumption": 10,
            "expected_consumption_limit": 12, "current_consumption": 2,
        })
        self.assertEqual(fractional_floor.status_code, 400)

    def test_settings_recalculate_expected_limits(self):
        response = self.client.put("/api/settings", json={
            "electricity_price_per_kwh": 0.25,
            "emissions_factor_kg_per_kwh": 0.41,
            "expected_increase_percentage": 25,
            "warning_threshold_percentage": 75,
            "critical_threshold_percentage": 100,
            "refresh_interval_seconds": 20,
        })
        self.assertEqual(response.status_code, 200)
        self.assertAlmostEqual(response.get_json()["emissions_factor_kg_per_kwh"], 0.41)
        room = self.room("101")
        self.assertAlmostEqual(room["expected_consumption_limit"], room["average_monthly_consumption"] * 1.25)
        invalid = self.client.put("/api/settings", json={"warning_threshold_percentage": 100})
        self.assertEqual(invalid.status_code, 400)

    def test_threshold_change_records_new_warning_state(self):
        room = self.room("101")
        before = len(self.client.get("/api/alerts").get_json())
        response = self.client.put("/api/settings", json={
            "warning_threshold_percentage": 60,
            "critical_threshold_percentage": 90,
        })
        self.assertEqual(response.status_code, 200)
        alerts = self.client.get("/api/alerts").get_json()
        self.assertGreater(len(alerts), before)
        self.assertTrue(any(alert["room_number"] == room["room_number"] and alert["alert_type"] == "WARNING" for alert in alerts))

    def test_room_creation_update_and_history(self):
        payload = {
            "room_number": "406",
            "floor_number": 4,
            "average_monthly_consumption": 50,
            "expected_consumption_limit": 60,
            "current_consumption": 20,
        }
        created = self.client.post("/api/rooms", json=payload)
        self.assertEqual(created.status_code, 201)
        room_id = created.get_json()["id"]
        self.assertEqual(self.client.get("/api/floors").status_code, 200)
        payload["current_consumption"] = 30
        updated = self.client.put(f"/api/rooms/{room_id}", json=payload)
        self.assertEqual(updated.status_code, 200)
        history = self.client.get(f"/api/consumption/history?room_id={room_id}").get_json()
        self.assertEqual([record["consumption_kwh"] for record in history], [20, 30])

    def test_readings_persist_after_database_reopen(self):
        room = self.room()
        self.client.post("/api/consumption", json={"room_id": room["id"], "consumption_kwh": 88.5})
        connection = wattwatch.connect_db()
        saved = connection.execute("SELECT current_consumption FROM rooms WHERE id = ?", (room["id"],)).fetchone()
        connection.close()
        self.assertEqual(saved["current_consumption"], 88.5)

    def test_reading_timestamp_and_notes_are_persisted(self):
        room = self.room()
        response = self.client.post("/api/consumption", json={
            "room_id": room["id"],
            "consumption_kwh": 80,
            "recorded_at": "2026-10-20T09:30",
            "notes": "Checked HVAC schedule",
        })
        self.assertEqual(response.status_code, 200)
        history = self.client.get(f"/api/consumption/history?room_id={room['id']}").get_json()
        saved = next(item for item in history if item["notes"] == "Checked HVAC schedule")
        self.assertEqual(saved["notes"], "Checked HVAC schedule")
        self.assertFalse(saved["is_simulated"])
        self.assertIn("2026-10-20T09:30", saved["recorded_at"])

    def test_demo_simulation_is_tagged_and_can_be_stopped(self):
        response = self.client.post("/api/demo/simulate")
        self.assertEqual(response.status_code, 201)
        simulation = response.get_json()
        self.assertTrue(simulation["simulated"])
        alert_id = simulation["alert_id"]
        alerts = self.client.get("/api/alerts").get_json()
        simulated_alert = next(alert for alert in alerts if alert["id"] == alert_id)
        self.assertTrue(simulated_alert["is_simulated"])
        self.assertEqual(self.client.get("/api/dashboard").get_json()["active_simulation"], True)
        self.assertEqual(self.client.post("/api/demo/simulate").status_code, 409)
        stopped = self.client.post("/api/demo/simulation/stop")
        self.assertEqual(stopped.status_code, 200)
        self.assertEqual(stopped.get_json()["room"]["status"], "Normal")
        self.assertFalse(self.client.get("/api/dashboard").get_json()["active_simulation"])
        acknowledged = next(alert for alert in self.client.get("/api/alerts").get_json() if alert["id"] == alert_id)
        self.assertTrue(acknowledged["acknowledged"])
        self.assertTrue(any(item["is_simulated"] for item in self.client.get(
            f"/api/consumption/history?room_id={simulation['room']['id']}"
        ).get_json()))

    def test_sound_preference_persists(self):
        response = self.client.put("/api/settings", json={"sound_enabled": True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.get("/api/settings").get_json()["sound_enabled"], 1)

    def test_reset_restores_seeded_rooms_and_settings(self):
        room = self.room()
        self.client.post("/api/consumption", json={"room_id": room["id"], "consumption_kwh": 10})
        reset = self.client.post("/api/demo/reset")
        self.assertEqual(reset.status_code, 200)
        self.assertIn("preserved", reset.get_json()["message"])
        self.assertEqual(self.client.get("/api/dashboard").get_json()["summary"]["room_count"], 15)
        self.assertEqual(self.client.get("/api/settings").get_json()["expected_increase_percentage"], 20)
        history = self.client.get(f"/api/consumption/history?room_id={room['id']}").get_json()
        self.assertTrue(any(item["consumption_kwh"] == 10 and not item["is_simulated"] for item in history))

    def test_demo_scenarios_are_tagged_and_reversible(self):
        for scenario in ("normal", "spike", "sustained", "after_hours"):
            with self.subTest(scenario=scenario):
                response = self.client.post("/api/demo/simulate", json={"scenario": scenario})
                self.assertEqual(response.status_code, 201)
                result = response.get_json()
                self.assertTrue(result["simulated"])
                self.assertEqual(result["scenario"], scenario)
                alerts = self.client.get("/api/alerts").get_json()
                event = next(alert for alert in alerts if alert["id"] == result["alert_id"])
                self.assertTrue(event["is_simulated"])
                if scenario == "after_hours":
                    self.assertIn("cannot independently establish", event["reason"])
                history_before_stop = self.client.get(
                    f"/api/consumption/history?room_id={result['room']['id']}"
                ).get_json()
                self.assertTrue(any(item["is_simulated"] for item in history_before_stop))
                self.assertEqual(self.client.post("/api/demo/simulation/stop").status_code, 200)

    def test_historical_reading_does_not_replace_current_value(self):
        room = self.room("101")
        response = self.client.post("/api/consumption", json={
            "room_id": room["id"],
            "consumption_kwh": 25,
            "recorded_at": "2000-01-01T12:00",
        })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["historical_only"])
        self.assertEqual(self.room("101")["current_consumption"], room["current_consumption"])

    def test_stale_readings_are_neutral_and_spikes_include_reason(self):
        room = self.room("101")
        with wattwatch.app.app_context():
            connection = wattwatch.get_db()
            old_time = (wattwatch.datetime.now(wattwatch.timezone.utc) - wattwatch.timedelta(days=60)).astimezone().isoformat()
            connection.execute("UPDATE rooms SET updated_at = ? WHERE id = ?", (old_time, room["id"]))
            connection.execute("UPDATE consumption_history SET recorded_at = ? WHERE room_id = ?", (old_time, room["id"]))
            connection.commit()
        stale = self.room("101")
        self.assertEqual(stale["status"], "No recent reading")
        self.assertEqual(stale["reading_state"], "stale")
        spike = self.client.post("/api/consumption", json={"room_id": room["id"], "consumption_kwh": 170})
        self.assertEqual(spike.status_code, 200)
        self.assertEqual(spike.get_json()["status"], "Critical")
        critical = next(alert for alert in self.client.get("/api/alerts").get_json() if alert["room_id"] == room["id"] and alert["alert_type"] == "CRITICAL")
        self.assertIn("Possible sudden increase", critical["reason"])
        self.assertIn("saved non-simulated readings", critical["reason"])

    def test_csv_report_contains_summary_readings_alerts_and_validates_period(self):
        room = self.room("101")
        self.client.post("/api/consumption", json={
            "room_id": room["id"],
            "consumption_kwh": 170,
            "notes": "report test",
        })
        report = self.client.get("/api/reports.csv")
        self.assertEqual(report.status_code, 200)
        self.assertIn("text/csv", report.content_type)
        self.assertIn(b"Floor summary", report.data)
        self.assertIn(b"report test", report.data)
        self.assertIn(b"Possible sudden increase", report.data)
        self.assertEqual(self.client.get("/api/reports.csv?start=invalid").status_code, 400)
        self.assertEqual(self.client.get("/api/reports.csv?start=2026-10-25&end=2026-10-01").status_code, 400)


if __name__ == "__main__":
    unittest.main()
