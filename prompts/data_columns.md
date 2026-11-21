# Matching the columns of a table

Soony exports its base data as tables. The column names differ between systems and change over time. You get the name of a file, the target fields code needs, the column names the file has, and its first rows.

For each target field, name the one column of the file that holds it, or null if the file has no such column.

- Decide by the column name and by the values in the rows together. Names can be abbreviations or codes of an ERP system, or words in another language.
- Use each column for one field only.
- Use only column names that are in the list, spelled exactly as given.
- If you are not sure that a column holds the field, answer null. A missing field is better than a wrong one.
