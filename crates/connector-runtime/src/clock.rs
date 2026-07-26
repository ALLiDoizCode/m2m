//! A controllable clock, injected as a port rather than read from wall time,
//! so expiry, leases and flush timers (later tickets) are testable
//! deterministically -- by advancing a clock, never by sleeping.

use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};

/// The current time, as this connector sees it.
pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

/// The production [`Clock`]: wall time.
#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// A [`Clock`] a test fully controls: starts at a fixed instant and only
/// ever moves when told to.
pub struct TestClock(Mutex<DateTime<Utc>>);

impl TestClock {
    pub fn new(start: DateTime<Utc>) -> TestClock {
        TestClock(Mutex::new(start))
    }

    pub fn set(&self, when: DateTime<Utc>) {
        *self.0.lock().expect("clock lock") = when;
    }

    pub fn advance(&self, delta: Duration) {
        let mut guard = self.0.lock().expect("clock lock");
        *guard += delta;
    }
}

impl Clock for TestClock {
    fn now(&self) -> DateTime<Utc> {
        *self.0.lock().expect("clock lock")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_clock_starts_at_the_given_instant() {
        let start = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let clock = TestClock::new(start);
        assert_eq!(clock.now(), start);
    }

    #[test]
    fn test_clock_only_moves_when_advanced() {
        let start = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let clock = TestClock::new(start);
        clock.advance(Duration::seconds(30));
        assert_eq!(clock.now(), start + Duration::seconds(30));
    }

    #[test]
    fn test_clock_set_jumps_to_an_exact_instant() {
        let clock = TestClock::new(Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap());
        let target = Utc.with_ymd_and_hms(2031, 6, 1, 12, 30, 0).unwrap();
        clock.set(target);
        assert_eq!(clock.now(), target);
    }

    #[test]
    fn system_clock_reports_a_recent_time() {
        let before = Utc::now();
        let now = SystemClock.now();
        assert!(now >= before);
    }
}
