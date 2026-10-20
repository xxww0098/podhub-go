package domain

import "encoding/json"

// Cut-in minutes the Seller API accepts.
var cutInMinutes = map[int64]bool{
	15: true, 30: true, 60: true, 120: true, 180: true,
	240: true, 300: true, 360: true, 420: true, 480: true,
}

// Preset is the pinned shipping preset payload.
type Preset struct {
	Mode               string
	CutIn              int64
	Address            Coordinates
	IsAutoAssembly     bool
	CourierComment     string
	CourierPhones      []string
	DeliverToPVZ       bool
	DeliveryCosts      *Costs
	DeliveryMethodName string
	ReturnSettings     *ReturnSettings
	MinOrderValue      *int64
	WarehouseName      string
	Phone              string
	Timetable          Timetable
	WeightUnit         string
}

// Coordinates is the warehouse point.
type Coordinates struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

// Costs is one aggregator price interval. Weights are grams on the wire.
type Costs struct {
	MinWeight     *int64 `json:"min_weight,omitempty"`
	MaxWeight     *int64 `json:"max_weight,omitempty"`
	MinOrderPrice *int64 `json:"min_order_price,omitempty"`
	MaxOrderPrice *int64 `json:"max_order_price,omitempty"`
	SellerPayment *int64 `json:"seller_payment,omitempty"`
}

// ReturnSettings is the buyer-return block.
type ReturnSettings struct {
	ContactDays          *int64 `json:"contact_days,omitempty"`
	PostOfficeZipcode    string `json:"post_office_zipcode,omitempty"`
	ReturnMethod         string `json:"return_method,omitempty"`
	TransportCompanyName string `json:"transport_company_name,omitempty"`
}

// Timetable is the warehouse calendar.
type Timetable struct {
	Holidays    []Holiday      `json:"holidays"`
	WorkingDays []WorkingHours `json:"working_days"`
}

// Holiday is one closed interval.
type Holiday struct {
	Day  string `json:"day"`
	From string `json:"from"`
	To   string `json:"to"`
}

// WorkingHours is one open interval.
type WorkingHours struct {
	Day  string `json:"day"`
	From string `json:"from"`
	To   string `json:"to"`
}

type aggregatorCreate struct {
	AddressCoordinates Coordinates    `json:"address_coordinates"`
	IsAutoAssembly     bool           `json:"is_auto_assembly"`
	DeliveryMethod     deliveryMethod `json:"delivery_method"`
	MinOrderValue      *int64         `json:"min_order_value,omitempty"`
	Name               string         `json:"name"`
	Phone              string         `json:"phone"`
	TimetableWarehouse Timetable      `json:"timetable_warehouse"`
}

type deliveryMethod struct {
	CourierComment string          `json:"courier_comment"`
	CourierPhones  []string        `json:"courier_phones"`
	CutIn          int64           `json:"cut_in"`
	DeliverToPVZ   bool            `json:"deliver_to_pvz"`
	DeliveryCosts  *Costs          `json:"delivery_costs,omitempty"`
	Name           string          `json:"name"`
	ReturnSettings *ReturnSettings `json:"return_settings,omitempty"`
}

// DecodePreset reads the camelCase preset jsonb.
func DecodePreset(raw []byte) (Preset, error) {
	var wire struct {
		Mode           string      `json:"mode"`
		CutIn          int64       `json:"cutIn"`
		Address        Coordinates `json:"addressCoordinates"`
		IsAutoAssembly bool        `json:"isAutoAssembly"`
		CourierComment string      `json:"courierComment"`
		CourierPhones  []string    `json:"courierPhones"`
		DeliverToPVZ   bool        `json:"deliverToPvz"`
		DeliveryCosts  *struct {
			MinWeight     *int64 `json:"minWeight"`
			MaxWeight     *int64 `json:"maxWeight"`
			MinOrderPrice *int64 `json:"minOrderPrice"`
			MaxOrderPrice *int64 `json:"maxOrderPrice"`
			SellerPayment *int64 `json:"sellerPayment"`
		} `json:"deliveryCosts"`
		DeliveryMethodName string          `json:"deliveryMethodName"`
		ReturnSettings     *ReturnSettings `json:"returnSettings"`
		MinOrderValue      *int64          `json:"minOrderValue"`
		WarehouseName      string          `json:"warehouseName"`
		Phone              string          `json:"phone"`
		Timetable          struct {
			Holidays []struct {
				Day  string `json:"day"`
				From string `json:"from"`
				To   string `json:"to"`
			} `json:"holidays"`
			WorkingDays []struct {
				Day  string `json:"day"`
				From string `json:"from"`
				To   string `json:"to"`
			} `json:"workingDays"`
		} `json:"timetableWarehouse"`
		WeightUnit string `json:"weightUnit"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return Preset{}, errMap
	}
	p := Preset{
		Mode: wire.Mode, CutIn: wire.CutIn, Address: wire.Address, IsAutoAssembly: wire.IsAutoAssembly,
		CourierComment: wire.CourierComment, CourierPhones: wire.CourierPhones, DeliverToPVZ: wire.DeliverToPVZ,
		DeliveryMethodName: wire.DeliveryMethodName, ReturnSettings: wire.ReturnSettings,
		MinOrderValue: wire.MinOrderValue, WarehouseName: wire.WarehouseName, Phone: wire.Phone,
		WeightUnit: wire.WeightUnit,
	}
	if wire.DeliveryCosts != nil {
		p.DeliveryCosts = &Costs{
			MinWeight: wire.DeliveryCosts.MinWeight, MaxWeight: wire.DeliveryCosts.MaxWeight,
			MinOrderPrice: wire.DeliveryCosts.MinOrderPrice, MaxOrderPrice: wire.DeliveryCosts.MaxOrderPrice,
			SellerPayment: wire.DeliveryCosts.SellerPayment,
		}
	}
	for _, h := range wire.Timetable.Holidays {
		p.Timetable.Holidays = append(p.Timetable.Holidays, Holiday{Day: h.Day, From: h.From, To: h.To})
	}
	for _, d := range wire.Timetable.WorkingDays {
		p.Timetable.WorkingDays = append(p.Timetable.WorkingDays, WorkingHours{Day: d.Day, From: d.From, To: d.To})
	}
	return p, nil
}

// MapAggregatorCreate is map::map_aggregator_create. A non-aggregator mode,
// an undocumented cut_in, or a weight that overflows i64 fails the map.
// The caller turns that into HTTP 400.
func MapAggregatorCreate(p Preset) ([]byte, error) {
	if p.Mode != "aggregator" {
		return nil, errMap
	}
	if !cutInMinutes[p.CutIn] {
		return nil, errMap
	}
	costs, err := mapCosts(p)
	if err != nil {
		return nil, err
	}
	phones := p.CourierPhones
	if phones == nil {
		phones = []string{}
	}
	if p.Timetable.Holidays == nil {
		p.Timetable.Holidays = []Holiday{}
	}
	if p.Timetable.WorkingDays == nil {
		p.Timetable.WorkingDays = []WorkingHours{}
	}
	body := aggregatorCreate{
		AddressCoordinates: p.Address,
		IsAutoAssembly:     p.IsAutoAssembly,
		DeliveryMethod: deliveryMethod{
			CourierComment: p.CourierComment,
			CourierPhones:  phones,
			CutIn:          p.CutIn,
			DeliverToPVZ:   p.DeliverToPVZ,
			DeliveryCosts:  costs,
			Name:           p.DeliveryMethodName,
			ReturnSettings: p.ReturnSettings,
		},
		MinOrderValue:      p.MinOrderValue,
		Name:               p.WarehouseName,
		Phone:              p.Phone,
		TimetableWarehouse: p.Timetable,
	}
	return json.Marshal(body)
}

func mapCosts(p Preset) (*Costs, error) {
	if p.DeliveryCosts == nil {
		return nil, nil
	}
	src := *p.DeliveryCosts
	skip := p.WeightUnit == "unpinned" && (src.MinWeight != nil || src.MaxWeight != nil)
	minW, err := wireGrams(p.WeightUnit, src.MinWeight, skip)
	if err != nil {
		return nil, err
	}
	maxW, err := wireGrams(p.WeightUnit, src.MaxWeight, skip)
	if err != nil {
		return nil, err
	}
	out := &Costs{
		MinWeight: minW, MaxWeight: maxW,
		MinOrderPrice: src.MinOrderPrice, MaxOrderPrice: src.MaxOrderPrice,
		SellerPayment: src.SellerPayment,
	}
	if out.MinWeight == nil && out.MaxWeight == nil && out.MinOrderPrice == nil && out.MaxOrderPrice == nil && out.SellerPayment == nil {
		return nil, nil
	}
	return out, nil
}

func wireGrams(unit string, value *int64, skip bool) (*int64, error) {
	if skip || value == nil {
		return nil, nil
	}
	if unit == "kg" {
		if *value > (1<<63-1)/1000 {
			return nil, errMap
		}
		g := *value * 1000
		return &g, nil
	}
	return value, nil
}

type mapError struct{}

func (mapError) Error() string { return "map" }

var errMap error = mapError{}

// MapFailed reports a preset that cannot become an rFBS Express body.
func MapFailed(err error) bool {
	_, ok := err.(mapError)
	return ok
}
