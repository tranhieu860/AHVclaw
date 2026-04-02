package scheduler

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ValidateSchedule validates a cron expression (5-field: min hour dom month dow).
func ValidateSchedule(schedule string) error {
	fields := strings.Fields(schedule)
	if len(fields) != 5 {
		return fmt.Errorf("cron expression must have 5 fields, got %d", len(fields))
	}
	limits := [][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 7}}
	names := []string{"minute", "hour", "day-of-month", "month", "day-of-week"}
	for i, field := range fields {
		if err := validateField(field, limits[i][0], limits[i][1], names[i]); err != nil {
			return err
		}
	}
	return nil
}

func validateField(field string, min, max int, name string) error {
	if field == "*" {
		return nil
	}
	for _, part := range strings.Split(field, ",") {
		if strings.Contains(part, "/") {
			tokens := strings.SplitN(part, "/", 2)
			if tokens[0] != "*" {
				if err := checkRange(tokens[0], min, max, name); err != nil {
					return err
				}
			}
			step, err := strconv.Atoi(tokens[1])
			if err != nil || step <= 0 {
				return fmt.Errorf("invalid step in %s: %s", name, part)
			}
			continue
		}
		if strings.Contains(part, "-") {
			bounds := strings.SplitN(part, "-", 2)
			lo, err1 := strconv.Atoi(bounds[0])
			hi, err2 := strconv.Atoi(bounds[1])
			if err1 != nil || err2 != nil || lo < min || hi > max || lo > hi {
				return fmt.Errorf("invalid range in %s: %s", name, part)
			}
			continue
		}
		if err := checkRange(part, min, max, name); err != nil {
			return err
		}
	}
	return nil
}

func checkRange(s string, min, max int, name string) error {
	v, err := strconv.Atoi(s)
	if err != nil || v < min || v > max {
		return fmt.Errorf("value %s out of range [%d-%d] for %s", s, min, max, name)
	}
	return nil
}

// NextRunTime calculates the next run time from now for the given cron schedule and timezone.
func NextRunTime(schedule, timezone string) (time.Time, error) {
	return NextRunTimeAfter(schedule, timezone, time.Now())
}

// NextRunTimeAfter calculates the next run time after a given time.
func NextRunTimeAfter(schedule, timezone string, after time.Time) (time.Time, error) {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid timezone: %s", timezone)
	}
	fields := strings.Fields(schedule)
	if len(fields) != 5 {
		return time.Time{}, fmt.Errorf("invalid cron: need 5 fields")
	}
	minutes := expandField(fields[0], 0, 59)
	hours := expandField(fields[1], 0, 23)
	doms := expandField(fields[2], 1, 31)
	months := expandField(fields[3], 1, 12)
	dows := expandField(fields[4], 0, 6)

	t := after.In(loc).Truncate(time.Minute).Add(time.Minute)

	// Search up to 366 days ahead
	limit := t.Add(366 * 24 * time.Hour)
	for t.Before(limit) {
		if !inSet(months, int(t.Month())) {
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, loc)
			continue
		}
		domMatch := fields[2] == "*" || inSet(doms, t.Day())
		dowMatch := fields[4] == "*" || inSet(dows, int(t.Weekday()))
		bothSpecified := fields[2] != "*" && fields[4] != "*"
		dayOK := false
		if bothSpecified {
			dayOK = domMatch || dowMatch
		} else {
			dayOK = domMatch && dowMatch
		}
		if !dayOK {
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, loc)
			continue
		}
		if !inSet(hours, t.Hour()) {
			t = t.Add(time.Hour)
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), 0, 0, 0, loc)
			continue
		}
		if !inSet(minutes, t.Minute()) {
			t = t.Add(time.Minute)
			continue
		}
		return t.UTC(), nil
	}
	return time.Time{}, fmt.Errorf("no next run found within 366 days")
}

func expandField(field string, min, max int) map[int]bool {
	set := make(map[int]bool)
	if field == "*" {
		for i := min; i <= max; i++ {
			set[i] = true
		}
		return set
	}
	for _, part := range strings.Split(field, ",") {
		if strings.Contains(part, "/") {
			tokens := strings.SplitN(part, "/", 2)
			step, _ := strconv.Atoi(tokens[1])
			start := min
			if tokens[0] != "*" {
				start, _ = strconv.Atoi(tokens[0])
			}
			for i := start; i <= max; i += step {
				set[i] = true
			}
			continue
		}
		if strings.Contains(part, "-") {
			bounds := strings.SplitN(part, "-", 2)
			lo, _ := strconv.Atoi(bounds[0])
			hi, _ := strconv.Atoi(bounds[1])
			for i := lo; i <= hi; i++ {
				set[i] = true
			}
			continue
		}
		v, _ := strconv.Atoi(part)
		if v == 7 {
			v = 0 // Sunday
		}
		set[v] = true
	}
	return set
}

func inSet(set map[int]bool, v int) bool {
	return set[v]
}

// HumanReadableSchedule converts a cron expression to a human-readable string.
func HumanReadableSchedule(schedule string) string {
	fields := strings.Fields(schedule)
	if len(fields) != 5 {
		return schedule
	}
	min, hour, dom, mon, dow := fields[0], fields[1], fields[2], fields[3], fields[4]

	if min != "*" && hour != "*" && dom == "*" && mon == "*" && dow == "*" {
		return fmt.Sprintf("Hàng ngày lúc %s:%s", zeroPad(hour), zeroPad(min))
	}
	if min != "*" && hour != "*" && dom == "*" && mon == "*" && dow == "1-5" {
		return fmt.Sprintf("Ngày thường lúc %s:%s", zeroPad(hour), zeroPad(min))
	}
	if min != "*" && hour != "*" && dom == "*" && mon == "*" && dow != "*" {
		return fmt.Sprintf("Mỗi %s lúc %s:%s", dowName(dow), zeroPad(hour), zeroPad(min))
	}
	return schedule
}

func zeroPad(s string) string {
	if len(s) == 1 {
		return "0" + s
	}
	return s
}

func dowName(s string) string {
	names := map[string]string{"0": "Chủ nhật", "1": "Thứ hai", "2": "Thứ ba", "3": "Thứ tư", "4": "Thứ năm", "5": "Thứ sáu", "6": "Thứ bảy", "7": "Chủ nhật"}
	if n, ok := names[s]; ok {
		return n
	}
	return s
}
