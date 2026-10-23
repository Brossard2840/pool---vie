# Fleur de lys dessinée dans une boîte 100 × 100 (centre x = 50).
HALF = ('M50 3 C59 15 64 31 58 52 L50 52 Z '
        'M46 52 C40 36 25 26 14 32 C3 39 5 57 17 61 C25 64 31 58 29 52 C27 47 21 47 20 52 C15 46 20 38 28 40 C36 42 42 50 44 56 Z '
        'M47 65 C39 66 31 71 27 82 C36 79 43 75 48 69 Z')
def lys(fill):
    return (f'<g fill="{fill}"><path d="{HALF}"/><path d="{HALF}" transform="translate(100 0) scale(-1 1)"/>'
            f'<rect x="29" y="54" width="42" height="9" rx="2.5"/><path d="M50 62 C55 69 54 78 50 90 C46 78 45 69 50 62 Z"/></g>')
