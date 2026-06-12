Payload sent when turning do not disturb on (set `active` to `0` to turn off):

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
            "start_time": 43200,
            "end_time": 50400,
            "active": 1,
            "unlock": 0,
            "week": [
              1,
              2,
              3,
              4,
              5,
              6,
              7
            ],
            "repeat": 1,
            "workmode": 0,
            "id": 1
          }
        ]
      }
    }
  }
}
```