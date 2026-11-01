//! Comoving distance in a flat LambdaCDM universe, in Mpc/h.

use libm::{asin, atan2, cos, sin, sqrt};
use std::f64::consts::PI;

pub const C_OVER_H0: f64 = 2997.92458;
pub const OMEGA_M: f64 = 0.31;
pub const OMEGA_L: f64 = 0.69;
const STEP: f64 = 0.0005;

/// Comoving distance table with z steps of 0.0005, read by linear interpolation.
pub struct DistanceTable {
    d: Vec<f64>,
}

impl DistanceTable {
    pub fn new(zmax: f64) -> Self {
        Self::with_params(OMEGA_M, OMEGA_L, zmax)
    }

    pub fn with_params(om: f64, ol: f64, zmax: f64) -> Self {
        let n = (zmax / STEP) as usize + 3;
        let inv_e = |z: f64| {
            let a = 1.0 + z;
            1.0 / sqrt(om * a * a * a + ol)
        };
        let mut d = Vec::with_capacity(n);
        d.push(0.0);
        let (mut acc, mut prev) = (0.0, inv_e(0.0));
        for k in 1..n {
            let cur = inv_e(k as f64 * STEP);
            acc += 0.5 * (prev + cur) * STEP;
            prev = cur;
            d.push(acc * C_OVER_H0);
        }
        Self { d }
    }

    pub fn distance(&self, z: f64) -> f64 {
        let f = z / STEP;
        let k = (f as usize).min(self.d.len() - 2);
        let t = f - k as f64;
        self.d[k] + (self.d[k + 1] - self.d[k]) * t
    }

    /// The redshift at distance `r` (inverse of [`Self::distance`]).
    pub fn redshift(&self, r: f64) -> f64 {
        let k = self.d.partition_point(|&v| v <= r).clamp(1, self.d.len() - 1) - 1;
        let t = (r - self.d[k]) / (self.d[k + 1] - self.d[k]);
        (k as f64 + t) * STEP
    }
}

/// `x = r cos(dec) cos(ra), y = r cos(dec) sin(ra), z = r sin(dec)`; angles in degrees.
pub fn to_cartesian(ra_deg: f64, dec_deg: f64, r: f64) -> [f64; 3] {
    let (a, d) = (ra_deg * PI / 180.0, dec_deg * PI / 180.0);
    let cd = cos(d);
    [r * cd * cos(a), r * cd * sin(a), r * sin(d)]
}

/// Returns `(ra_deg in [0, 360), dec_deg, r)`.
pub fn to_spherical(p: [f64; 3]) -> (f64, f64, f64) {
    let r = sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]);
    let mut ra = atan2(p[1], p[0]) * 180.0 / PI;
    if ra < 0.0 {
        ra += 360.0;
    }
    let dec = if r > 0.0 { asin(p[2] / r) * 180.0 / PI } else { 0.0 };
    (ra, dec, r)
}

/// Sine and cosine are exposed so other modules stay on the same libm.
pub fn sin_deg(a: f64) -> f64 {
    sin(a * PI / 180.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Computed once with astropy `FlatLambdaCDM(H0=100, Om0=0.31, Tcmb0=0)`.
    const ASTROPY: [(f64, f64); 7] = [
        (0.003, 8.987497),
        (0.01, 29.909405),
        (0.05, 148.137247),
        (0.1, 292.699757),
        (0.12, 349.508326),
        (0.3, 834.264296),
        (0.6, 1538.262260),
    ];

    #[test]
    fn matches_astropy_within_a_tenth_of_a_percent() {
        let t = DistanceTable::new(0.6);
        for (z, want) in ASTROPY {
            let got = t.distance(z);
            assert!(((got - want) / want).abs() < 1e-3, "z={z}: {got} vs {want}");
        }
    }

    #[test]
    fn z_of_a_tenth_is_about_292_7() {
        let got = DistanceTable::new(0.2).distance(0.1);
        assert!((got - 292.7).abs() < 0.05, "{got}");
    }

    #[test]
    fn redshift_inverts_distance() {
        let t = DistanceTable::new(0.6);
        for z in [0.003, 0.0512, 0.31, 0.6] {
            assert!((t.redshift(t.distance(z)) - z).abs() < 1e-9);
        }
    }

    #[test]
    fn spherical_round_trip() {
        let (ra, dec, r) = to_spherical(to_cartesian(185.5, 31.25, 200.0));
        assert!((ra - 185.5).abs() < 1e-9 && (dec - 31.25).abs() < 1e-9 && (r - 200.0).abs() < 1e-9);
    }
}
