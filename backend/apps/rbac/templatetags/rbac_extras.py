from django import template

register = template.Library()


@register.filter(name='dictlookup')
def dictlookup(value, key):
    """Look up a key on a dict-like value inside a template."""
    if value is None:
        return False
    try:
        return value.get(key, False)
    except AttributeError:
        return getattr(value, key, False)
