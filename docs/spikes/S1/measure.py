#!/usr/bin/env python3
"""Run a command and report wall time, CPU time, peak child RSS and peak
system memory/swap use (sampled from /proc/meminfo every 2 s).

Usage: measure.py <label> <timeout-seconds> -- <command...>
Stand-in for `/usr/bin/time -v`, which is not installed on the dev box.
"""
import os, resource, subprocess, sys, threading, time

def meminfo():
    vals = {}
    with open('/proc/meminfo') as f:
        for line in f:
            k, v = line.split(':', 1)
            vals[k] = int(v.split()[0])  # kB
    used = vals['MemTotal'] - vals['MemAvailable']
    swap = vals['SwapTotal'] - vals['SwapFree']
    return used, swap

def main():
    label, timeout = sys.argv[1], int(sys.argv[2])
    cmd = sys.argv[sys.argv.index('--') + 1:]
    base_used, base_swap = meminfo()
    peak = {'used': base_used, 'swap': base_swap}
    stop = threading.Event()

    def sampler():
        while not stop.is_set():
            u, s = meminfo()
            peak['used'] = max(peak['used'], u)
            peak['swap'] = max(peak['swap'], s)
            stop.wait(2)

    t = threading.Thread(target=sampler, daemon=True)
    t.start()
    start = time.time()
    print(f'[measure:{label}] start {time.strftime("%Y-%m-%dT%H:%M:%S")} cmd={" ".join(cmd)}', flush=True)
    proc = subprocess.Popen(cmd, start_new_session=True)
    try:
        rc = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, 9)
        proc.wait()
        rc = 'TIMEOUT'
    stop.set(); t.join()
    wall = time.time() - start
    ru = resource.getrusage(resource.RUSAGE_CHILDREN)
    mb = lambda kb: f'{kb/1024:.0f} MiB'
    print(f'[measure:{label}] exit={rc} wall={wall/60:.1f} min user={ru.ru_utime/60:.1f} min sys={ru.ru_stime/60:.1f} min '
          f'max_child_rss={mb(ru.ru_maxrss)} peak_sys_used={mb(peak["used"])} (baseline {mb(base_used)}) '
          f'peak_swap_used={mb(peak["swap"])} (baseline {mb(base_swap)})', flush=True)
    sys.exit(0 if rc == 0 else 1)

if __name__ == '__main__':
    main()
