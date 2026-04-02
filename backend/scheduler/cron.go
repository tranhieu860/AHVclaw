package scheduler

import (
	"fmt"
	"time"

	"github.com/robfig/cron/v3"
)

var parser = cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)

// ValidateSchedule checks if a cron expression is valid.
func ValidateSchedule(schedule string) error {
	_, err := parser.Parse(schedule)
	if err != nil {
		return fmt.Errorf("invalid cron schedule %s: %w", schedule, err)
	}
	return nil
}

// NextRunTime returns the next run time from now in the given timezone.
func NextRunTime(schedule, timezone string) (time.Time, error) {
	return NextRunTimeAfter(schedule, timezone, time.Now())
}

// NextRunTimeAfter returns the next run time after the given time in the given timezone.
func NextRunTimeAfter(schedule, timezone string, after time.Time) (time.Time, error) {
	sched, err := parser.Parse(schedule)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid cron schedule %s: %w", schedule, err)
	}

	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid timezone %s: %w", timezone, err)
	}

	afterInTZ := after.In(loc)
	nextInTZ := sched.Next(afterInTZ)
	return nextInTZ.UTC(), nil
}
