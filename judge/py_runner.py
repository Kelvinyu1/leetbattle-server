import json, sys, signal, builtins, types, resource
import typing

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

# very restricted builtins 
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

    "__build_class__": builtins.__build_class__,
    "object": builtins.object,
    "Exception": builtins.Exception,
    "ValueError": builtins.ValueError,
    "TypeError": builtins.TypeError,
    "__import__": builtins.__import__,
}

safe_globals = {
    "__builtins__": ALLOWED_BUILTINS,
    "__name__": "__main__", 
    "List": typing.List,
    "Dict": typing.Dict,
    "Set": typing.Set,
    "Deque": typing.Deque,
    "Tuple": typing.Tuple,
    "Optional": typing.Optional,
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

    # If you want debug, send to stderr, not stdout:
    # print("DEBUG tests:", tests, file=sys.stderr)

    # Reset locals for each run
    global safe_locals
    safe_locals = {}

    # print("starting run function")

    try:
        # Execute user code with restricted builtins
        exec(compile(code, "<user>", "exec"), safe_globals, safe_locals)

        fn = None

        # 1. Try direct function with given exportName
        if export_name:
            if export_name in safe_locals and callable(safe_locals[export_name]):
                fn = safe_locals[export_name]
            elif export_name in safe_globals and callable(safe_globals[export_name]):
                fn = safe_globals[export_name]

            # 2. Handle typical LeetCode pattern: class Solution: def <export_name>(...)
            if fn is None:
                SolClass = safe_locals.get("Solution") or safe_globals.get("Solution")
                if isinstance(SolClass, type) and hasattr(SolClass, export_name):
                    def wrapper(*args, _SolClass=SolClass, _name=export_name):
                        obj = _SolClass()
                        method = getattr(obj, _name)
                        return method(*args)
                    fn = wrapper

        # 3. Fallback: pick a top-level function (but NOT classes like Solution)
        if fn is None:
            candidates = [
                v for k, v in safe_locals.items()
                if callable(v) and not isinstance(v, type) and not k.startswith("__")
            ]
            if candidates:
                fn = candidates[-1]

        if not callable(fn):
            print(json.dumps({
                "verdict": "Runtime Error",
                "passCount": 0,
                "total": len(tests),
                "timeMs": 0,
                "error": "No callable solution function found (check exportName / Solution)"
            }))
            return

        passed = 0
        for t in tests:
            args = t.get("input", {}).get("args", [])
            expected = t.get("output")
            try:
                got = fn(*args)
                # Optional debug:
                # print("DEBUG got:", got, "expected:", expected)
                if deep_equal(got, expected):
                    passed += 1
            except Exception as e:
                # Optional debug:
                # print("DEBUG error:", e)
                pass

        verdict = "Accepted" if tests and passed == len(tests) else "Wrong Answer"
        print(json.dumps({
            "verdict": verdict,
            "passCount": passed,
            "total": len(tests),
            "timeMs": 0
        }))


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
