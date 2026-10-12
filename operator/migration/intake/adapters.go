package intake

import (
	"bytes"
	"encoding/binary"
	"encoding/csv"
	"fmt"
	"io"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// DecodeTextWithBOM converts UTF-8 or UTF-16 (BE/LE) with BOM into a standard UTF-8 string.
func DecodeTextWithBOM(data []byte) (string, error) {
	if len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		return string(data[3:]), nil
	}
	if len(data) >= 2 && data[0] == 0xfe && data[1] == 0xff {
		// UTF-16 BE
		u16 := make([]uint16, (len(data)-2)/2)
		for i := 0; i < len(u16); i++ {
			u16[i] = binary.BigEndian.Uint16(data[2+i*2:])
		}
		runes := utf16.Decode(u16)
		return string(runes), nil
	}
	if len(data) >= 2 && data[0] == 0xff && data[1] == 0xfe {
		// UTF-16 LE
		u16 := make([]uint16, (len(data)-2)/2)
		for i := 0; i < len(u16); i++ {
			u16[i] = binary.LittleEndian.Uint16(data[2+i*2:])
		}
		runes := utf16.Decode(u16)
		return string(runes), nil
	}
	if utf8.Valid(data) {
		return string(data), nil
	}
	return "", fmt.Errorf("undetermined or unsupported non-UTF text encoding")
}

// CSVTable describes a parsed CSV/TSV with header and row counts.
type CSVTable struct {
	Delimiter   rune
	Header      []string
	RowCount    int
	SampleRows  [][]string
	HasMultiline bool
}

// ParseCSV parses a CSV or TSV buffer safely with auto-detected delimiter.
func ParseCSV(data []byte, maxSampleRows int) (*CSVTable, error) {
	// Strip UTF-8 BOM if present
	if len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		data = data[3:]
	}

	if !utf8.Valid(data) {
		return nil, fmt.Errorf("CSV data contains invalid UTF-8")
	}

	// Delimiter detection: comma vs tab vs semicolon
	delimiter := detectDelimiter(data)

	reader := csv.NewReader(bytes.NewReader(data))
	reader.Comma = delimiter
	reader.LazyQuotes = true
	reader.FieldsPerRecord = -1 // Allow variable fields if raw export has footer

	var header []string
	var sampleRows [][]string
	rowCount := 0
	hasMultiline := false

	firstRow := true
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read CSV row %d: %w", rowCount+1, err)
		}

		if firstRow {
			header = record
			firstRow = false
			continue
		}

		rowCount++
		if len(sampleRows) < maxSampleRows {
			sampleRows = append(sampleRows, record)
		}
		for _, field := range record {
			if strings.ContainsRune(field, '\n') {
				hasMultiline = true
			}
		}
	}

	return &CSVTable{
		Delimiter:   delimiter,
		Header:      header,
		RowCount:    rowCount,
		SampleRows:  sampleRows,
		HasMultiline: hasMultiline,
	}, nil
}

func detectDelimiter(data []byte) rune {
	lines := strings.SplitN(string(data), "\n", 5)
	if len(lines) == 0 {
		return ','
	}
	sample := lines[0]
	commas := strings.Count(sample, ",")
	tabs := strings.Count(sample, "\t")
	semicolons := strings.Count(sample, ";")

	if tabs > commas && tabs > semicolons {
		return '\t'
	}
	if semicolons > commas && semicolons > tabs {
		return ';'
	}
	return ','
}
