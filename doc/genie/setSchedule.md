Payload sent when creating a schedule:

```json
{
  "state": {
    "desired": {
      "cmd": "mow_regular",
      "data": {
        "timezone": 2,
        "timezone_sec": 7200,
        "version": 1,
        "value": [
          {
            "start_time": 28800,
            "end_time": 64800,
            "active": 1,
            "unlock": 1,
            "workmode": 1,
            "week": [
              6
            ],
            "repeat": 1,
            "area_id": [
              100
            ],
            "area_points": [],
            "use_end_time": 1,
            "id": 2
          }
        ]
      }
    }
  }
}
```