//! Parallel helpers that fall back to sequential loops without the `parallel` feature.
//! Each chunk's result depends only on its index, so output never depends on scheduling.

#[cfg(feature = "parallel")]
use rayon::prelude::*;

/// Calls `f(chunk_index, chunk)` for each `size`-long chunk of `out`.
pub fn for_chunks<T, F>(out: &mut [T], size: usize, f: F)
where
    T: Send,
    F: Fn(usize, &mut [T]) + Sync + Send,
{
    #[cfg(feature = "parallel")]
    out.par_chunks_mut(size).enumerate().for_each(|(i, c)| f(i, c));
    #[cfg(not(feature = "parallel"))]
    out.chunks_mut(size).enumerate().for_each(|(i, c)| f(i, c));
}

/// Runs both closures, in parallel when available.
pub fn join<A, B, RA, RB>(a: A, b: B) -> (RA, RB)
where
    A: FnOnce() -> RA + Send,
    B: FnOnce() -> RB + Send,
    RA: Send,
    RB: Send,
{
    #[cfg(feature = "parallel")]
    return rayon::join(a, b);
    #[cfg(not(feature = "parallel"))]
    {
        let ra = a();
        let rb = b();
        (ra, rb)
    }
}
