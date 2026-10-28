"""Curated fallback problem bank (D3) — used when live generation fails validation."""
from __future__ import annotations

BANK = [
    {
        "slug": "two-sum",
        "title": "Two Sum",
        "topics": ["hash map", "arrays"],
        "difficulty": "easy",
        "fn_name": "twoSum",
        "signature": "twoSum(nums: list[int], target: int) -> list[int]",
        "statement": (
            "Given an array of integers `nums` and an integer `target`, return the "
            "**indices** of the two numbers that add up to `target`. Exactly one solution "
            "exists; you may not use the same element twice. Return indices in ascending "
            "input order."
        ),
        "samples": [
            {"input": [[2, 7, 11, 15], 9], "output": [0, 1]},
            {"input": [[3, 2, 4], 6], "output": [1, 2]},
        ],
        "hidden": [
            {"input": [[3, 3], 6], "output": [0, 1]},
            {"input": [[0, 4, 3, 0], 0], "output": [0, 3]},
            {"input": [[-1, -2, -3, -4, -5], -8], "output": [2, 4]},
            {"input": [[5, 75, 25], 100], "output": [1, 2]},
            {"input": [[2, 5, 5, 11], 10], "output": [1, 2]},
            {"input": [[1, 1, 1, 1, 1], 2], "output": [0, 1]},
        ],
        "reference_py": (
            "def twoSum(nums, target):\n"
            "    seen = {}\n"
            "    for i, n in enumerate(nums):\n"
            "        if target - n in seen:\n"
            "            return [seen[target - n], i]\n"
            "        seen[n] = i\n"
            "    return []\n"
        ),
        "reference_js": (
            "function twoSum(nums, target){\n"
            "  const m = new Map();\n"
            "  for (let i = 0; i < nums.length; i++){\n"
            "    if (m.has(target - nums[i])) return [m.get(target - nums[i]), i];\n"
            "    m.set(nums[i], i);\n"
            "  }\n"
            "  return [];\n"
            "}\n"
        ),
        "expected_complexity": "O(n) time, O(n) space with a hash map",
    },
    {
        "slug": "valid-parentheses",
        "title": "Valid Parentheses",
        "topics": ["stack", "strings"],
        "difficulty": "easy",
        "fn_name": "isValid",
        "signature": "isValid(s: str) -> bool",
        "statement": (
            "Given a string `s` containing only the characters `()[]{}`, determine if the "
            "input is valid: brackets must close in the correct order."
        ),
        "samples": [
            {"input": ["()[]{}"], "output": True},
            {"input": ["([)]"], "output": False},
        ],
        "hidden": [
            {"input": ["(]"], "output": False},
            {"input": ["([])"], "output": True},
            {"input": [""], "output": True},
            {"input": ["(((("], "output": False},
            {"input": ["]"], "output": False},
            {"input": ["{[()()]}"], "output": True},
        ],
        "reference_py": (
            "def isValid(s):\n"
            "    pairs = {'}': '{', ']': '[', ')': '('}\n"
            "    st = []\n"
            "    for ch in s:\n"
            "        if ch in '([{':\n"
            "            st.append(ch)\n"
            "        elif not st or st.pop() != pairs[ch]:\n"
            "            return False\n"
            "    return not st\n"
        ),
        "reference_js": (
            "function isValid(s){\n"
            "  const pairs = {'}':'{', ']':'[', ')':'('};\n"
            "  const st = [];\n"
            "  for (const ch of s) {\n"
            "    if ('([{'.includes(ch)) st.push(ch);\n"
            "    else if (!st.length || st.pop() !== pairs[ch]) return false;\n"
            "  }\n"
            "  return st.length === 0;\n"
            "}\n"
        ),
        "expected_complexity": "O(n) time, O(n) space with a stack",
    },
    {
        "slug": "merge-intervals",
        "title": "Merge Intervals",
        "topics": ["sorting", "intervals"],
        "difficulty": "medium",
        "fn_name": "merge",
        "signature": "merge(intervals: list[list[int]]) -> list[list[int]]",
        "statement": (
            "Given an array of `intervals` where `intervals[i] = [start_i, end_i]`, merge "
            "all overlapping intervals and return the result sorted by start."
        ),
        "samples": [
            {"input": [[[1, 3], [2, 6], [8, 10], [15, 18]]], "output": [[1, 6], [8, 10], [15, 18]]},
            {"input": [[[1, 4], [4, 5]]], "output": [[1, 5]]},
        ],
        "hidden": [
            {"input": [[[1, 4], [0, 2], [3, 5]]], "output": [[0, 5]]},
            {"input": [[[1, 4], [2, 3]]], "output": [[1, 4]]},
            {"input": [[[2, 2], [2, 2]]], "output": [[2, 2]]},
            {"input": [[[0, 10], [1, 2], [3, 4], [5, 6]]], "output": [[0, 10]]},
            {"input": [[[5, 6], [1, 2]]], "output": [[1, 2], [5, 6]]},
            {"input": [[[1, 3], [2, 4], [3, 5], [4, 6]]], "output": [[1, 6]]},
        ],
        "reference_py": (
            "def merge(intervals):\n"
            "    if not intervals:\n"
            "        return []\n"
            "    intervals = sorted(intervals, key=lambda x: (x[0], x[1]))\n"
            "    out = [list(intervals[0])]\n"
            "    for s, e in intervals[1:]:\n"
            "        if s <= out[-1][1]:\n"
            "            out[-1][1] = max(out[-1][1], e)\n"
            "        else:\n"
            "            out.append([s, e])\n"
            "    return out\n"
        ),
        "reference_js": (
            "function merge(intervals){\n"
            "  if (!intervals.length) return [];\n"
            "  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);\n"
            "  const out = [intervals[0].slice()];\n"
            "  for (const [s, e] of intervals.slice(1)) {\n"
            "    if (s <= out[out.length - 1][1])\n"
            "      out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);\n"
            "    else out.push([s, e]);\n"
            "  }\n"
            "  return out;\n"
            "}\n"
        ),
        "expected_complexity": "O(n log n) time (sort), O(n) space",
    },
]
