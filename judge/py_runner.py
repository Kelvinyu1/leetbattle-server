import json, sys, signal, builtins, types, resource

# -------- time & memory limits --------
# CPU seconds
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
# Address space ~256MB
try:
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
except Exception:
    pass

def _timeout(signum, frame):
    raise TimeoutError("Time Limit Exceeded")
signal.signal(signal.SIGALRM, _timeout)
signal.alarm(3)  # wall timeout ~3s

# -------- very restricted builtins --------
ALLOWED_BUILTINS = {
    "abs": builtins.abs,
    "all": builtins.all,
    "any": builtins.any,
    "bin": builtins.bin,
    "bool": builtins.bool,
    "dict": builtins.dict,
    "enumerate": builtins.enumerate,
    "filter": builtins.filter,
    "float": builtins.float,
    "int": builtins.int,
    "len": builtins.len,
    "list": builtins.list,
    "map": builtins.map,
    "max": builtins.max,
    "min": builtins.min,
    "pow": builtins.pow,
    "range": builtins.range,
    "reversed": builtins.reversed,
    "set": builtins.set,
    "sorted": builtins.sorted,
    "str": builtins.str,
    "sum": builtins.sum,
    "tuple": builtins.tuple,
    "zip": builtins.zip,
    # no __import__, no open, no eval/exec again, etc.
}

safe_globals = {
    "__builtins__": ALLOWED_BUILTINS,
}
safe_locals = {}

def deep_equal(a, b):
    return a == b

def run():
    raw = sys.stdin.read()
    data = json.loads(raw)
    code = data.get("code") or ""
    export_name = data.get("exportName")
    tests = data.get("tests") or []

    # Execute user code with restricted builtins
    exec(compile(code, "<user>", "exec"), safe_globals, safe_locals)

    # Locate solution function
    fn = None
    if export_name and export_name in safe_locals:
        fn = safe_locals[export_name]
    elif export_name and export_name in safe_globals:
        fn = safe_globals[export_name]
    else:
        # fallback: try to find the only callable defined by user
        candidates = [v for k, v in {**safe_globals, **safe_locals}.items() if callable(v)]
        fn = candidates[-1] if candidates else None

    if not callable(fn):
        print(json.dumps({
            "verdict": "Runtime Error",
            "passCount": 0,
            "total": len(tests),
            "timeMs": 0,
            "error": "No callable solution function found (check exportName)"
        }))
        return

    passed = 0
    for t in tests:
        args = t.get("input", {}).get("args", [])
        expected = t.get("output")
        try:
            got = fn(*args)
            if deep_equal(got, expected):
                passed += 1
        except Exception as e:
            # count as fail; continue
            pass

    verdict = "Accepted" if passed == len(tests) else "Wrong Answer"
    print(json.dumps({
        "verdict": verdict,
        "passCount": passed,
        "total": len(tests),
        "timeMs": 0
    }))

if __name__ == "__main__":
    try:
        run()
    except TimeoutError as e:
        print(json.dumps({
            "verdict": "Time Limit Exceeded",
            "passCount": 0,
            "total": 0,
            "timeMs": 0,
            "error": str(e)
        }))
    except Exception as e:
        print(json.dumps({
            "verdict": "Runtime Error",
            "passCount": 0,
            "total": 0,
            "timeMs": 0,
            "error": str(e)
        }))

