def _inr(value):
    """Format a number as Indian Rupee string with en-IN grouping.

    e.g. 1234567.50 → 'Rs. 12,34,567.50'
    """
    try:
        value = float(value)
    except (TypeError, ValueError):
        return 'Rs. 0.00'

    negative = value < 0
    value = abs(value)
    integer_part = int(value)
    decimal_part = f'{value - integer_part:.2f}'[1:]  # ".xx"

    s = str(integer_part)
    if len(s) <= 3:
        formatted = s
    else:
        last3 = s[-3:]
        rest = s[:-3]
        groups = []
        while rest:
            groups.append(rest[-2:])
            rest = rest[:-2]
        groups.reverse()
        formatted = ','.join(groups) + ',' + last3

    result = f'Rs. {formatted}{decimal_part}'
    if negative:
        result = f'-{result}'
    return result
