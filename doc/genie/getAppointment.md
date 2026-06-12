Example appointment file with only do not disturb:

```json
{
  "appointment_time": 1781245407,
  "timezone": 2,
  "timezone_sec": 7200,
  "value": [
    {
      "active": 1,
      "end_time": 50400,
      "id": 1,
      "repeat": 1,
      "start_time": 43200,
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
      "workmode": 0
    }
  ],
  "version": 1
}
```

With both do not disturb & schedule entry:

```json
{
  "appointment_time": 1781245598,
  "timezone": 2,
  "timezone_sec": 7200,
  "value": [
    {
      "active": 1,
      "end_time": 50400,
      "id": 1,
      "repeat": 1,
      "start_time": 43200,
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
      "workmode": 0
    },
    {
      "active": 1,
      "area_id": [
        100
      ],
      "area_points": [],
      "end_time": 64800,
      "id": 2,
      "repeat": 1,
      "start_time": 28800,
      "unlock": 1,
      "use_end_time": 1,
      "week": [
        6
      ],
      "workmode": 1
    }
  ],
  "version": 1
}
```